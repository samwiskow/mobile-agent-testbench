// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withIosSession } from '../src/ios-session.mjs';

test('a physical iPad has one owner, while another device can run independently', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ios-session-'));
  const options = { udid: '00008101-000A31263861401E', lockDirectory: directory };
  try {
    await withIosSession(async () => {
      await assert.rejects(withIosSession(() => {}, options), /reserved/);
      await withIosSession(() => {}, { ...options, udid: '00008101-000A31263861401F' });
    }, options);
    await withIosSession(() => {}, options);
    await assert.rejects(withIosSession(() => { throw new Error('Device disconnected'); }, options), /Device disconnected/);
    await withIosSession(() => {}, options);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
