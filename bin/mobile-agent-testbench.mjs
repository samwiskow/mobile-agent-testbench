#!/usr/bin/env node
// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startComputerConsole } from '../src/console.mjs';
import { requireAndroidSession } from '../src/session.mjs';
import { runSession } from '../src/session-cli.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'session') return runSession(args.slice(1));
  if (args.includes('--help') || !args.length) {
    console.log(`Mobile Agent Testbench

mobile-agent-testbench --app PACKAGE [--device SERIAL | --avd NAME] [--output DIRECTORY]
mobile-agent-testbench session [--device SERIAL | --avd NAME] -- COMMAND [ARGS...]

Requires Node.js 22+, Android platform-tools (adb), and an authorized device.
--avd starts a temporary instance of an existing AVD and discards its data on exit.
Open the printed local URL in a browser. Press Ctrl-C to stop and release the device.`);
    return;
  }
  const serve = args[0] === 'serve';
  if (serve) args.shift();
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!['--app', '--device', '--avd', '--output'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    options[flag.slice(2)] = value;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(options.app ?? '')) throw new Error('--app requires a valid Android package.');
  if (!serve) {
    return runSession([
      ...(options.device ? ['--device', options.device] : []), ...(options.avd ? ['--avd', options.avd] : []), '--',
      process.execPath, fileURLToPath(import.meta.url), 'serve', '--app', options.app,
      ...(options.output ? ['--output', options.output] : []),
    ]);
  }
  const owner = await requireAndroidSession();
  const results = path.resolve(options.output ?? path.join('.mobile-agent-testbench', randomUUID()));
  await mkdir(results, { recursive: true });
  const execute = promisify(execFile);
  const adb = async (...command) => (await execute('adb', ['-s', owner.serial, ...command], {
    encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, timeout: 10000,
  })).stdout;
  const record = { appId: options.app, serial: owner.serial, startedAt: new Date().toISOString(), status: 'running' };
  let deviceConsole;
  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
  try {
    deviceConsole = await startComputerConsole({ adb, results, appId: options.app });
    await writeFile(path.join(results, 'run.json'), JSON.stringify(record, null, 2));
    console.log(`Mobile Agent Testbench: ${deviceConsole.url}\nEvidence: ${results}`);
    await stopped;
  } finally {
    await deviceConsole?.stop();
    record.status = 'stopped';
    record.finishedAt = new Date().toISOString();
    await writeFile(path.join(results, 'run.json'), JSON.stringify(record, null, 2));
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stop);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
