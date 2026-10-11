// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startCommand, sessionDirectory } from '../src/session.mjs';

test('the CLI reserves its selected device, records input and releases it on exit', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'console-cli-'));
  const serial = `console-cli-test-${process.pid}`;
  const calls = path.join(root, 'adb-calls.jsonl');
  const output = path.join(root, 'evidence');
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'adb'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ADB_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'devices') console.log('List of devices attached\\n${serial}\\tdevice');
else if (args.includes('resolve-activity')) console.log('org.example.notes/.Launcher');
else if (args.includes('screencap')) { const png=Buffer.alloc(24); png.writeUInt32BE(1080,16); png.writeUInt32BE(2400,20); process.stdout.write(png); }
`, { mode: 0o755 });
  const child = startCommand(process.execPath, [fileURLToPath(new URL('../bin/mobile-agent-testbench.mjs', import.meta.url)),
    '--device', serial, '--app', 'org.example.notes', '--output', output], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ADB_TEST_LOG: calls },
  });
  let stdout = '', stderr = '';
  child.child.stderr.on('data', (data) => { stderr += data; });
  try {
    const url = await Promise.race([
      new Promise((resolve) => child.child.stdout.on('data', (data) => {
        stdout += data; const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+\//); if (match) resolve(match[0]);
      })),
      child.completion.then(() => { throw new Error(`Console exited before ready: ${stderr}`); }),
    ]);
    const owner = JSON.parse(await readFile(`${sessionDirectory}-${serial}/owner.json`, 'utf8'));
    assert.equal(owner.serial, serial);
    const response = await fetch(`${url}action`, { method: 'POST', headers: { Origin: new URL(url).origin },
      body: JSON.stringify({ kind: 'text', text: 'Hello console' }) });
    assert.equal(response.status, 200);
    const log = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(log.some((args) => args.join(' ') === `-s ${serial} shell input text Hello%sconsole`));
    assert.ok(log.filter((args) => args[0] !== 'devices').every((args) => args[0] === '-s' && args[1] === serial));
    await child.stop();
    const run = JSON.parse(await readFile(path.join(output, 'run.json'), 'utf8'));
    assert.equal(run.appId, 'org.example.notes');
    assert.equal(run.status, 'stopped');
    await assert.rejects(access(`${sessionDirectory}-${serial}`), { code: 'ENOENT' });
    await assert.rejects(fetch(url));
  } finally { await child.stop(); await rm(root, { recursive: true, force: true }); }
});
