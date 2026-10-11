// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startCommand, withAndroidSession } from './session.mjs';

export async function withNewEmulator(action, {
  avd, signal, env = process.env, lockDirectory, reserve = withAndroidSession,
  inspect = promisify(execFile), start = startCommand, portsAvailable = emulatorPortsAvailable,
} = {}) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  const executable = sdk ? path.join(sdk, 'emulator', 'emulator') : 'emulator';
  for (let port = 5554; port <= 5682; port += 2) {
    let selected = false;
    try {
      const result = await reserve(async (session) => {
        const deviceEnv = { ...env, ...session };
        const serial = session.ANDROID_SERIAL;
        const { stdout } = await inspect('adb', ['devices'], { env: deviceEnv, signal, timeout: 5000 });
        if (stdout.split(/\r?\n/).some((line) => line.split(/\s+/)[0] === serial)
          || !await portsAvailable(port)) return;
        selected = true;
        const emulator = start(executable, ['-avd', avd, '-port', String(port), '-read-only',
          '-no-snapshot', '-no-window', '-no-audio', '-no-boot-anim'], { env: deviceEnv });
        try {
          await waitForEmulator(emulator, serial, { env: deviceEnv, signal, inspect });
          console.log(`Temporary Android emulator ${avd} ready on ${serial}; changes are discarded on exit.`);
          return await action(session);
        } finally { await emulator.stop(); }
      }, { serial: `emulator-${port}`, signal, lockDirectory, wait: false });
      if (selected) return result;
    } catch (error) { if (error.code !== 'ANDROID_SESSION_BUSY') throw error; }
  }
  throw new Error('No free Android emulator port pair is available.');
}

async function waitForEmulator(emulator, serial, { env, signal, inspect }) {
  const controller = new AbortController();
  const readinessSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
  const stopped = emulator.completion.then(({ code, signal: exitSignal }) => {
    throw new Error(`Owned emulator exited before boot completed (${exitSignal ?? code}).`);
  });
  const ready = async () => {
    for (;;) {
      readinessSignal.throwIfAborted();
      try {
        const { stdout } = await inspect('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
          env, signal: readinessSignal, timeout: 5000,
        });
        if (stdout.trim() === '1') return;
      } catch { readinessSignal.throwIfAborted(); }
      await delay(500, undefined, { signal: readinessSignal });
    }
  };
  try { await Promise.race([ready(), stopped]); }
  finally { controller.abort(); }
}

async function emulatorPortsAvailable(port) {
  const servers = [];
  try {
    for (const candidate of [port, port + 1]) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, resolve);
      });
    }
    return true;
  } catch (error) {
    if (error.code === 'EADDRINUSE') return false;
    throw error;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}
