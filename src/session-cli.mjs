// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { requireAndroidSession, resolveDevice, runCommand, withAndroidSession } from './session.mjs';
import { withNewEmulator } from './emulator.mjs';

export async function runSession(input, { env = process.env, withSession = withAndroidSession } = {}) {
  const args = [...input];
  let avd, requested = env.ANDROID_SERIAL;
  while (args[0]?.startsWith('--')) {
    const flag = args.shift();
    if (flag === '--') break;
    if (!['--device', '--avd'].includes(flag)) throw new Error(`Unknown session option: ${flag}`);
    const value = args.shift();
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
    if (flag === '--avd') avd = value;
    else requested = value;
  }
  if (avd && requested) throw new Error('Choose --avd NAME or --device SERIAL, not both.');
  if (!args.length) throw new Error('Usage: mobile-agent-testbench session [--device SERIAL | --avd NAME] -- <command> [args...]');
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, abort);
  try {
    if (env.MOBILE_AGENT_TESTBENCH_SESSION) {
      await requireAndroidSession(env);
      if (avd) throw new Error('Cannot start another emulator inside an Android session.');
      if (requested && requested !== env.ANDROID_SERIAL) throw new Error('Cannot change device inside an Android session.');
      await runCommand(args[0], args.slice(1), { env, signal: controller.signal, detached: false });
      return;
    }
    const run = (session) => runCommand(args[0], args.slice(1), {
      env: { ...env, ...session }, signal: controller.signal, stopTimeout: 15000,
    });
    if (avd) {
      await withNewEmulator(run, { avd, env, signal: controller.signal, reserve: withSession });
      return;
    }
    const devices = () => execFileSync('adb', ['devices'], { env, encoding: 'utf8' });
    const serial = resolveDevice(requested, devices());
    await withSession(async (session) => {
      resolveDevice(serial, devices());
      await run(session);
    }, { serial, signal: controller.signal });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, abort);
  }
}
