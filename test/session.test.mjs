// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withAndroidSession, runCommand, startCommand, requireAndroidSession, resolveDevice } from '../src/session.mjs';

test('a phone session can run while another worktree owns an emulator', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-parallel-test-'));
  try {
    await withAndroidSession(async (emulator) => {
      await withAndroidSession(async (phone) => {
        assert.equal((await requireAndroidSession(emulator)).serial, 'emulator-5554');
        assert.equal((await requireAndroidSession(phone)).serial, 'physical-phone');
      }, { serial: 'physical-phone', lockDirectory: path.join(root, 'lock'), signal: AbortSignal.timeout(1000) });
      assert.equal((await requireAndroidSession(emulator)).serial, 'emulator-5554');
    }, { serial: 'emulator-5554', lockDirectory: path.join(root, 'lock') });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worktrees queue for one Android session and cancellation releases ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-session-test-'));
  const events = [];
  const controller = new AbortController();
  const options = { lockDirectory: path.join(root, 'lock'), serial: 'emulator-5554' };
  try {
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const first = withAndroidSession(async () => {
      events.push('first');
      entered();
      await delay(10000, undefined, { signal: controller.signal });
    }, { ...options, signal: controller.signal });
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    await started;
    const second = withAndroidSession(async () => events.push('second'), options);
    await delay(150);
    assert.deepEqual(events, ['first']);
    controller.abort();
    await cancelled;
    await second;
    assert.deepEqual(events, ['first', 'second']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelling a queued run does not release the active session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-queue-test-'));
  const options = { lockDirectory: path.join(root, 'lock'), serial: 'emulator-5554' };
  let finish;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  const first = withAndroidSession(async () => { entered(); await hold; }, options);
  await enteredPromise;
  const controller = new AbortController();
  const queued = withAndroidSession(() => assert.fail('Cancelled waiter entered'), { ...options, signal: controller.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  controller.abort();
  await rejected;
  const { readFile } = await import('node:fs/promises');
  assert.equal(JSON.parse(await readFile(path.join(root, 'lock-emulator-5554/owner.json'))).pid, process.pid);
  finish();
  await first;
  await rm(root, { recursive: true, force: true });
});


test('cancellation stops command descendants before releasing the session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-process-test-'));
  const pidFile = path.join(root, 'child.pid');
  const controller = new AbortController();
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`;
  const active = withAndroidSession(() => runCommand(process.execPath, ['-e', script, pidFile], {
    signal: controller.signal,
  }), { serial: 'test', lockDirectory: path.join(root, 'lock'), signal: controller.signal });
  const rejected = assert.rejects(active, { name: 'AbortError' });
  try {
    for (let i = 0; i < 100; i++) {
      try { await access(pidFile); break; } catch { await delay(20); }
    }
    const childPid = Number(await readFile(pidFile, 'utf8'));
    controller.abort();
    await rejected;
    // The OS may take a short time to reap the terminated grandchild.
    for (let i = 0; i < 100; i++) {
      try { process.kill(childPid, 0); await delay(20); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        break;
      }
    }
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    await assert.rejects(access(path.join(root, 'lock-test')), { code: 'ENOENT' });
  } finally {
    controller.abort();
    await rejected;
    await rm(root, { recursive: true, force: true });
  }
});

test('independent processes in different directories share the same session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-worktrees-test-'));
  const lock = path.join(root, 'lock');
  const marker = path.join(root, 'entered');
  const other = path.join(root, 'other-worktree');
  await mkdir(other);
  const module = new URL('../src/session.mjs', import.meta.url).href;
  const script = `import {withAndroidSession} from ${JSON.stringify(module)};
    import {writeFile} from 'node:fs/promises';
    await withAndroidSession(() => writeFile(${JSON.stringify(marker)}, process.cwd()),
      { serial: 'test', lockDirectory: ${JSON.stringify(lock)} });`;
  let child;
  try {
    await withAndroidSession(async () => {
      child = startCommand(process.execPath, ['--input-type=module', '-e', script], { cwd: other, stdio: 'ignore' });
      await delay(200);
      await assert.rejects(access(marker), { code: 'ENOENT' });
    }, { serial: 'test', lockDirectory: lock });
    assert.equal((await child.completion).code, 0);
    assert.equal(await readFile(marker, 'utf8'), await realpath(other));
  } finally {
    await child?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a forged or missing ownership token cannot operate the device', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-owner-test-'));
  try {
    await assert.rejects(requireAndroidSession({}), /acquire the Android device/);
    await withAndroidSession(async (env) => {
      assert.equal((await requireAndroidSession(env)).serial, 'test');
      await assert.rejects(requireAndroidSession({ ...env, MOBILE_AGENT_TESTBENCH_SESSION: 'wrong' }), /ownership/);
    }, { serial: 'test', lockDirectory: path.join(root, 'lock') });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ambiguous devices fail instead of selecting another device', () => {
  const output = 'List of devices attached\nemulator-5554\tdevice\nphysical-phone\tdevice\n';
  assert.throws(() => resolveDevice(undefined, output), /exactly one device/);
  assert.equal(resolveDevice('emulator-5554', output), 'emulator-5554');
  assert.throws(() => resolveDevice('missing', output), /not available/);
});

test('new sessions do not bypass a legacy global session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-legacy-test-'));
  const lockDirectory = path.join(root, 'lock');
  try {
    await mkdir(lockDirectory);
    await writeFile(path.join(lockDirectory, 'owner.json'), JSON.stringify({ pid: process.pid, serial: 'emulator-5554' }));
    await assert.rejects(withAndroidSession(() => assert.fail('Bypassed legacy owner'), {
      serial: 'physical-phone', lockDirectory,
    }), /legacy.*session/i);
    assert.equal(JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'))).pid, process.pid);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an emulator allocator can skip a reserved device without waiting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-reserved-test-'));
  const options = { serial: 'emulator-5554', lockDirectory: path.join(root, 'lock') };
  try {
    await withAndroidSession(async (env) => {
      await assert.rejects(withAndroidSession(() => assert.fail('Entered reserved device'), {
        ...options, wait: false, signal: AbortSignal.timeout(1000),
      }), { code: 'ANDROID_SESSION_BUSY' });
      await requireAndroidSession(env);
    }, options);
  } finally { await rm(root, { recursive: true, force: true }); }
});
