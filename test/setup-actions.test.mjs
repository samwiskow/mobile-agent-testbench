// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startComputerConsole } from '../src/console.mjs';

test('only explicitly registered setup actions can run and their failures are recorded', async () => {
  const results = await mkdtemp(path.join(tmpdir(), 'console-setup-'));
  let runs = 0;
  const console = await startComputerConsole({ results, appId: 'org.example.notes',
    adb: () => assert.fail('Setup must not send undeclared device input'),
    setupActions: [{ id: 'seed', label: 'Load <sample>', run: async () => { runs++; throw new Error('Fixture failed'); } }],
  });
  try {
    const html = await (await fetch(console.url)).text();
    assert.match(html, /Load &lt;sample&gt;/);
    const send = (id) => fetch(`${console.url}action`, { method: 'POST',
      headers: { Origin: new URL(console.url).origin }, body: JSON.stringify({ kind: 'setup', id }) });
    assert.equal((await send('unknown')).status, 400);
    assert.equal(runs, 0);
    assert.equal((await send('seed')).status, 400);
    assert.equal(runs, 1);
    const records = (await readFile(path.join(results, 'actions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.at(-1).error, 'Fixture failed');
    assert.equal(records.at(-1).actionId, records.at(-2).actionId);
  } finally { await console.stop(); await rm(results, { recursive: true, force: true }); }
});
