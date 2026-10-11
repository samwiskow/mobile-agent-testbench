// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withAndroidSession, requireAndroidSession } from '../src/session.mjs';
import { withNewEmulator } from '../src/emulator.mjs';

test('parallel emulator sessions skip reserved serials and stop only their own processes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-emulator-test-'));
  const lockDirectory = path.join(root, 'lock');
  const running = new Set();
  const options = {
    avd: 'Pixel_7a', lockDirectory,
    portsAvailable: async () => true,
    inspect: async (command, args) => {
      assert.equal(command, 'adb');
      if (args[0] === 'devices') return { stdout: 'List of devices attached\n' };
      assert.ok(running.has(args[1]));
      assert.deepEqual(args.slice(2), ['shell', 'getprop', 'sys.boot_completed']);
      return { stdout: '1\n' };
    },
    start: (command, args) => {
      assert.ok(command.endsWith('emulator'));
      assert.ok(args.includes('-read-only'));
      assert.ok(args.includes('-no-snapshot'));
      const serial = `emulator-${args[args.indexOf('-port') + 1]}`;
      assert.ok(!running.has(serial));
      running.add(serial);
      let finish;
      return {
        completion: new Promise((resolve) => { finish = resolve; }),
        stop: async () => { running.delete(serial); finish({ code: 0 }); },
      };
    },
  };
  try {
    await withAndroidSession(async (existing) => {
      await withNewEmulator(async (first) => {
        assert.equal(first.ANDROID_SERIAL, 'emulator-5556');
        await withNewEmulator(async (second) => {
          assert.equal(second.ANDROID_SERIAL, 'emulator-5558');
          await requireAndroidSession(first);
          await requireAndroidSession(second);
          assert.equal(running.size, 2);
        }, options);
        assert.deepEqual([...running], ['emulator-5556']);
      }, options);
      await requireAndroidSession(existing);
      assert.equal(running.size, 0);
    }, { serial: 'emulator-5554', lockDirectory });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('connected devices and occupied port pairs are skipped before emulator startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'android-ports-test-'));
  let startedPort;
  let stopped = false;
  try {
    await withNewEmulator(async ({ ANDROID_SERIAL }) => assert.equal(ANDROID_SERIAL, 'emulator-5558'), {
      avd: 'Pixel_7a', lockDirectory: path.join(root, 'lock'),
      inspect: async (_, args) => ({ stdout: args[0] === 'devices' ? 'List of devices attached\nemulator-5554\toffline\n' : '1' }),
      portsAvailable: async (port) => port !== 5556,
      start: (_, args) => {
        startedPort = args[args.indexOf('-port') + 1];
        return { completion: new Promise(() => {}), stop: async () => { stopped = true; } };
      },
    });
    assert.equal(startedPort, '5558');
    assert.equal(stopped, true);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const failure of ['boot exit', 'cancel during boot', 'command failure']) {
  test(`${failure} stops the owned emulator before releasing its device`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'android-emulator-cleanup-test-'));
    const lockDirectory = path.join(root, 'lock');
    const controller = new AbortController();
    let stopped = false;
    let commandRan = false;
    try {
      await assert.rejects(withNewEmulator(async (env) => {
        commandRan = true;
        await requireAndroidSession(env);
        throw new Error('Command failed');
      }, {
        avd: 'Pixel_7a', lockDirectory, signal: controller.signal,
        portsAvailable: async () => true,
        inspect: async (_, args) => {
          if (args[0] === 'devices') return { stdout: 'List of devices attached\n' };
          if (failure === 'cancel during boot') controller.abort();
          return { stdout: failure === 'command failure' ? '1' : '0' };
        },
        start: () => ({
          completion: failure === 'boot exit' ? Promise.resolve({ code: 1 }) : new Promise(() => {}),
          stop: async () => {
            await assert.rejects(withAndroidSession(() => assert.fail('Released before cleanup'), {
              serial: 'emulator-5554', lockDirectory, wait: false,
            }), { code: 'ANDROID_SESSION_BUSY' });
            stopped = true;
          },
        }),
      }), failure === 'boot exit' ? /exited before boot/ : failure === 'command failure' ? /Command failed/ : { name: 'AbortError' });
      assert.equal(commandRan, failure === 'command failure');
      assert.equal(stopped, true);
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
