// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startCommand, runCommand, withAndroidSession } from '../src/session.mjs';
import { withNewEmulator } from '../src/emulator.mjs';

test('repeated cleanup shares one completion promise', async () => {
  const task = startCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const first = task.stop();
    assert.equal(task.stop(), first);
    await first;
    assert.equal(task.stop(), first);
  } finally { await task.stop(); }
});

test('a group permission error is accepted only after every live member has exited', async (t) => {
  const task = startCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const originalKill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -task.child.pid && signal === 'SIGKILL') {
      throw Object.assign(new Error('Group contains no live processes'), { code: 'EPERM' });
    }
    return originalKill(pid, signal);
  });
  try { await task.stop(); }
  finally {
    t.mock.restoreAll();
    try { originalKill(-task.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await task.completion;
  }
});

test('permission errors for a live process group remain cleanup failures', async (t) => {
  const task = startCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const denied = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  const originalKill = process.kill.bind(process);
  await delay(30);
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -task.child.pid) throw denied;
    return originalKill(pid, signal);
  });
  try { await assert.rejects(task.stop(), (error) => error === denied); }
  finally {
    t.mock.restoreAll();
    originalKill(-task.child.pid, 'SIGKILL');
    await task.completion;
  }
});

test('a failed cancellation stop rejects the command without waiting for its live child', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testbench-stop-failure-'));
  const lockDirectory = path.join(root, 'lock');
  const pidFile = path.join(root, 'command.pid');
  const controller = new AbortController();
  const denied = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  const originalKill = process.kill.bind(process);
  let group;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < 0 && signal === 'SIGTERM') { group = pid; throw denied; }
    return originalKill(pid, signal);
  });
  const result = withAndroidSession((session) => runCommand(process.execPath, ['-e',
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile,
  ], { signal: controller.signal, stdio: 'ignore', env: { ...process.env, ...session } }), {
    serial: 'test', lockDirectory, signal: controller.signal,
  }).then(() => ({}), (error) => ({ error }));
  try {
    for (let i = 0; i < 100; i++) {
      try { group = -Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(20); }
    }
    assert.ok(group, 'The owned command started');
    controller.abort();
    const outcome = await Promise.race([result, delay(1000).then(() => ({ timedOut: true }))]);
    assert.equal(outcome.error, denied, 'Failed cancellation must reach the caller');
    originalKill(group, 0);
    await access(`${lockDirectory}-test/owner.json`);
    await assert.rejects(withAndroidSession(() => assert.fail('Live command lost ownership'), {
      serial: 'test', lockDirectory, wait: false,
    }), { code: 'ANDROID_SESSION_BUSY' });
  } finally {
    t.mock.restoreAll();
    if (group) originalKill(group, 'SIGKILL');
    await result;
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ['denied stop', 'supervisor exit']) {
  test(`${failure} retains emulator ownership`, { timeout: 10000 }, async () => {
   const root = await mkdtemp(path.join(tmpdir(), 'testbench-supervisor-failure-'));
   const lockDirectory = path.join(root, 'lock');
   const pidFile = path.join(root, 'emulator.pid');
   const preload = path.join(root, 'deny-stop.mjs');
   await mkdir(path.join(root, 'emulator'));
   await writeFile(path.join(root, 'emulator/emulator'), `#!${process.execPath}
 require('node:fs').writeFileSync(process.env.TEST_EMULATOR_PID, String(process.pid));
 require('node:fs').writeFileSync(process.env.TEST_EMULATOR_PID + '.supervisor', String(process.ppid));
 setInterval(() => {}, 1000);
 `, { mode: 0o755 });
   await writeFile(preload, `
 if (process.argv[1]?.endsWith('/emulator-process.mjs')) {
   const kill = process.kill.bind(process);
   process.kill = (pid, signal) => {
     if (pid < 0 && signal === 'SIGTERM') throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
     return kill(pid, signal);
   };
 }
 `);
   try {
     await assert.rejects(withNewEmulator(async () => {
       if (failure === 'supervisor exit') process.kill(Number(await readFile(pidFile + '.supervisor', 'utf8')), 'SIGKILL');
     }, {
       avd: 'Pixel_7a', lockDirectory,
       env: { ...process.env, ANDROID_HOME: root, TEST_EMULATOR_PID: pidFile,
         NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''}${failure === 'denied stop' ? ` --import=${preload}` : ''}` },
       portsAvailable: async () => true,
       inspect: async (_, args) => {
         if (args[0] === 'devices') return { stdout: 'List of devices attached\n' };
         try { await readFile(pidFile); return { stdout: '1' }; }
         catch { return { stdout: '0' }; }
       },
     }), (error) => error.androidCleanupFailed === true);
     process.kill(Number(await readFile(pidFile, 'utf8')), 0);
     await access(`${lockDirectory}-emulator-5554/owner.json`);
     await assert.rejects(withAndroidSession(() => assert.fail('Live emulator lost ownership'), {
       serial: 'emulator-5554', lockDirectory, wait: false,
     }), { code: 'ANDROID_SESSION_BUSY' });
   } finally {
     try { process.kill(-Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); }
     catch (error) { if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error; }
     await rm(root, { recursive: true, force: true });
   }
 });
}
