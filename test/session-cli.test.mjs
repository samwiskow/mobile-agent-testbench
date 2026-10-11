// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startCommand, sessionDirectory } from '../src/session.mjs';

test('terminal hangup stops the owned command and releases the device', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'testbench-hangup-'));
  const serial = `hangup-test-${process.pid}`;
  const pidFile = path.join(root, 'command.pid');
  const lock = `${sessionDirectory}-${serial}`;
  await writeFile(path.join(root, 'adb'), `#!${process.execPath}\nconsole.log('List of devices attached\\n${serial}\\tdevice');`, { mode: 0o755 });
  const child = startCommand(process.execPath, [fileURLToPath(new URL('../bin/mobile-agent-testbench.mjs', import.meta.url)),
    'session', '--device', serial, '--', process.execPath, '-e',
    `require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`, pidFile,
  ], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, stdio: 'ignore' });
  let ownedPid;
  try {
    for (let i = 0; i < 100; i++) {
      try { ownedPid = Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(20); }
    }
    assert.ok(ownedPid);
    child.child.kill('SIGHUP');
    await child.completion;
    await assert.rejects(access(lock), { code: 'ENOENT' });
    assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' });
  } finally {
    if (ownedPid) { try { process.kill(ownedPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await child.stop();
    await rm(lock, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
