// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function withIosSession(action, { udid, lockDirectory = `/tmp/mobile-agent-testbench-ios-${process.getuid()}` }) {
  if (!/^[a-zA-Z0-9-]{16,40}$/.test(udid ?? '')) throw new Error('An exact iOS device UDID is required.');
  const directory = `${lockDirectory}-${udid}`;
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`iOS device ${udid} is reserved at ${directory}. Check its owner before starting another session.`);
    throw error;
  }
  const owner = { udid, token: randomUUID(), pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() };
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify(owner));
  let cleanupFailed = false;
  try { return await action(owner); }
  catch (error) { cleanupFailed = error.iosCleanupFailed === true; throw error; }
  finally {
    if (!cleanupFailed) {
      const current = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
      if (current.token !== owner.token) throw new Error('iOS device ownership changed; the session lock was preserved.');
      await rm(directory, { recursive: true });
    }
  }
}
