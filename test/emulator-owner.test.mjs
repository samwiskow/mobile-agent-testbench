// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startCommand } from '../src/session.mjs';

for (const ending of ['SIGKILL', 'SIGKILL during boot', 'SIGINT', 'SIGTERM', 'SIGHUP', 'success', 'failure']) {
  test(`${ending} stops the owned temporary emulator`, { timeout: 10000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'testbench-owner-loss-'));
    const pidFile = path.join(root, 'emulator.pid');
    const readyFile = path.join(root, 'ready');
    await mkdir(path.join(root, 'emulator'));
    await writeFile(path.join(root, 'emulator/emulator'), `#!${process.execPath}
require('node:fs').writeFileSync(process.env.TEST_EMULATOR_PID, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const owner = startCommand(process.execPath, ['--input-type=module', '-e', `
  import { readFile, writeFile } from 'node:fs/promises';
  import { withNewEmulator } from ${JSON.stringify(new URL('../src/emulator.mjs', import.meta.url).href)};
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => controller.abort());
  await withNewEmulator(async () => {
    await writeFile(${JSON.stringify(readyFile)}, 'ready');
    if (${JSON.stringify(ending)} === 'success') return;
    if (${JSON.stringify(ending)} === 'failure') throw new Error('Test command failed');
    await new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  }, {
    avd: 'Pixel_7a', signal: controller.signal, lockDirectory: ${JSON.stringify(path.join(root, 'lock'))},
    portsAvailable: async () => true,
    inspect: async (_, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\\n' };
      try { await readFile(${JSON.stringify(pidFile)}); return { stdout: ${JSON.stringify(ending)} === 'SIGKILL during boot' ? '0' : '1' }; }
      catch { return { stdout: '0' }; }
    },
  });
  `], { env: { ...process.env, ANDROID_HOME: root, TEST_EMULATOR_PID: pidFile }, stdio: 'ignore' });
    let emulatorPid;
    try {
      for (let i = 0; i < 100; i++) {
        try {
          emulatorPid = Number(await readFile(pidFile, 'utf8'));
          if (ending !== 'SIGKILL during boot') await readFile(readyFile);
          break;
        } catch { await delay(20); }
      }
      assert.ok(emulatorPid, 'The emulator started');
      if (ending.startsWith('SIG')) owner.child.kill(ending.split(' ')[0]);
      await owner.completion;
      let running = true;
      for (let i = 0; i < 150; i++) {
        try { process.kill(emulatorPid, 0); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
          running = false;
          break;
        }
        await delay(20);
      }
      assert.equal(running, false, 'The temporary emulator must stop');
      if (!ending.startsWith('SIGKILL')) {
        assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('lock-')), []);
      }
    } finally {
      if (emulatorPid) {
        try { process.kill(-emulatorPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await owner.stop();
      await rm(root, { recursive: true, force: true });
    }

  });
}
