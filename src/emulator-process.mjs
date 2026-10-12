// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import { startCommand } from './session.mjs';

async function main() {
  // IPC closure survives a killed owner, which cannot execute its finally block.
  if (!process.connected) return;
  const [command, ...args] = process.argv.slice(2);
  const emulator = startCommand(command, args, { stopTimeout: 1000 });
  let stopping;
  const report = (stopped, error) => new Promise((resolve) => {
    if (process.connected) process.send({ type: 'emulator-cleanup', stopped, error: error?.message }, () => resolve());
    else resolve();
  });
  const stop = () => {
    stopping ??= emulator.stop().then(() => report(true), async (error) => {
      await report(false, error);
      throw error;
    });
    stopping.catch(() => {});
  };
  process.once('disconnect', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
  try {
    const result = await emulator.completion;
    process.exitCode = result.code ?? 1;
  } finally {
    stop();
    await stopping;
    process.removeListener('disconnect', stop);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stop);
    if (process.connected) process.disconnect();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
