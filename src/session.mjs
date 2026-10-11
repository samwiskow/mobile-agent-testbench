// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const sessionDirectory = path.join('/tmp', `mobile-agent-testbench-${process.getuid()}`);

export async function withAndroidSession(action, {
  serial, signal, lockDirectory = sessionDirectory, wait = true,
} = {}) {
  if (!serial) throw new Error('An Android device serial is required.');
  const legacyDirectory = lockDirectory;
  lockDirectory = `${lockDirectory}-${encodeURIComponent(serial)}`;
  const owner = { token: randomUUID(), pid: process.pid, serial, cwd: process.cwd(), started: new Date().toISOString() };
  let queued = false;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await access(legacyDirectory);
      throw new Error(`Legacy Android session at ${legacyDirectory}. Let it finish and update active worktrees before starting per-device sessions.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!wait) throw Object.assign(new Error(`Android device ${serial} is reserved.`), { code: 'ANDROID_SESSION_BUSY' });
      if (!queued) {
        console.log(`Waiting for Android session: ${lockDirectory}`);
        queued = true;
      }
      try {
        const previous = JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
        try { process.kill(previous.pid, 0); } catch (error) {
          if (error.code === 'ESRCH') throw new Error(`Abandoned Android session at ${lockDirectory}. Check its owner and remaining processes before removing it.`);
          throw error;
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      await delay(250, undefined, { signal });
    }
  }
  try {
    await writeFile(path.join(lockDirectory, 'owner.json'), JSON.stringify(owner));
    signal?.throwIfAborted();
    return await action({
      ANDROID_SERIAL: serial,
      MOBILE_AGENT_TESTBENCH_SESSION: owner.token,
      MOBILE_AGENT_TESTBENCH_SESSION_DIRECTORY: lockDirectory,
    });
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

export async function requireAndroidSession(env = process.env) {
  const directory = env.MOBILE_AGENT_TESTBENCH_SESSION_DIRECTORY;
  if (!directory || !env.MOBILE_AGENT_TESTBENCH_SESSION) {
    throw new Error('Use mobile-agent-testbench session -- <command> to acquire the Android device first.');
  }
  const owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
  if (owner.token !== env.MOBILE_AGENT_TESTBENCH_SESSION || owner.serial !== env.ANDROID_SERIAL) {
    throw new Error('Android session ownership does not match this command.');
  }
  process.kill(owner.pid, 0);
  return owner;
}

export function startCommand(command, args, { env = process.env, cwd = process.cwd(), stdio = 'inherit', detached = true, stopTimeout = 2000 } = {}) {
  const child = spawn(command, args, { env, cwd, stdio, detached });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // Background commands can fail before the caller starts waiting for readiness.
  completion.catch(() => {});
  const stop = async () => {
    if (!child.pid) return;
    const kill = (signal) => {
      try { process.kill(detached ? -child.pid : child.pid, signal); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    kill('SIGTERM');
    await Promise.race([completion.catch(() => {}), delay(stopTimeout, undefined, { ref: false })]);
    kill('SIGKILL');
    await completion.catch(() => {});
  };
  return { child, completion, stop };
}

export async function runCommand(command, args, options = {}) {
  options.signal?.throwIfAborted();
  const task = startCommand(command, args, options);
  const abort = () => { void task.stop(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await task.completion;
    options.signal?.throwIfAborted();
    if (result.code !== 0) throw new Error(`${command} exited with ${result.code ?? result.signal}.`);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await task.stop();
  }
}

export function resolveDevice(requested, output) {
  const devices = output.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .filter(([, state]) => state === 'device').map(([serial]) => serial);
  if (requested && devices.includes(requested)) return requested;
  if (requested) throw new Error(`Android device ${requested} is not available.`);
  if (devices.length !== 1) throw new Error('Connect exactly one device or pass --device SERIAL.');
  return devices[0];
}
