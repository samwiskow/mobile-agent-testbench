// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startComputerConsole } from '../src/console.mjs';

test('an unrelated app restarts through its declared launcher activity', async () => {
  const results = await mkdtemp(path.join(tmpdir(), 'portable-console-'));
  const calls = [];
  const console = await startComputerConsole({ results, appId: 'org.example.notes', adb: async (...args) => {
    calls.push(args);
    return Buffer.from(args.includes('resolve-activity') ? 'org.example.notes/org.example.ui.Launcher\n' : '');
  } });
  try {
    const response = await fetch(`${console.url}action`, { method: 'POST',
      headers: { Origin: new URL(console.url).origin }, body: JSON.stringify({ kind: 'restart' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1), ['shell', 'am', 'start', '-W', '-n', 'org.example.notes/org.example.ui.Launcher']);
    assert.ok(calls.some((args) => args.join(' ') === 'shell am force-stop org.example.notes'));
    const html = await (await fetch(console.url)).text();
    assert.doesNotMatch(html, /Longwork|Fixture|Reset test data/);
  } finally { await console.stop(); await rm(results, { recursive: true, force: true }); }
});
