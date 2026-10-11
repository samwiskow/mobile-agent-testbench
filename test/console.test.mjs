// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { startComputerConsole } from '../src/console.mjs';

test('screen input keeps native coordinates while the next screenshot loads', async () => {
  const html = await readFile(new URL('../src/console.html', import.meta.url), 'utf8');
  const requests = [];
  const screen = {
    naturalWidth: 1080, naturalHeight: 2400,
    getBoundingClientRect: () => ({ left: 16, top: 16, width: 310, height: 688 }),
    setPointerCapture() {}, addEventListener() {},
  };
  const status = { textContent: 'Loading device screen…' };
  const context = vm.createContext({
    document: { querySelector: (selector) => selector === '#screen' ? screen : selector === '#status' ? status : {}, querySelectorAll: () => [] },
    setInterval() {}, Date, Math, Promise,
    URL: { createObjectURL: () => 'blob:screen', revokeObjectURL() {} }, AbortSignal,
    createImageBitmap: async () => ({ width: 1080, height: 2400, close() {} }),
    fetch: async (_url, options) => {
      if (!options?.body) return { ok: true, blob: async () => ({}) };
      requests.push(JSON.parse(options.body)); return { json: async () => ({ kind: 'tap' }) };
    },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise((resolve) => setImmediate(resolve));
  screen.naturalWidth = 0; screen.naturalHeight = 0;
  screen.onpointerdown({ clientX: 132, clientY: 657, pointerId: 1 });
  screen.onpointerup({ clientX: 132, clientY: 657 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[0].kind, 'tap');
  assert.equal(requests[0].x, 404);
  assert.equal(requests[0].y, 2236);
});

test('slow or failed captures do not overlap or replace the last valid image', async () => {
  const html = await readFile(new URL('../src/console.html', import.meta.url), 'utf8');
  let tick;
  let finishCapture;
  let requests = 0;
  const screen = { src: 'blob:previous', addEventListener() {} };
  const status = { textContent: 'Device screen ready' };
  const context = vm.createContext({
    document: { querySelector: (selector) => selector === '#screen' ? screen : selector === '#status' ? status : {}, querySelectorAll: () => [] },
    setInterval: (callback) => { tick = callback; }, Date, Math, Promise, AbortSignal,
    URL: { createObjectURL: () => 'blob:new', revokeObjectURL() {} },
    fetch: () => { requests++; return new Promise((resolve) => { finishCapture = resolve; }); },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise((resolve) => setImmediate(resolve));
  tick(); tick(); tick();
  assert.equal(requests, 1);
  assert.equal(screen.src, 'blob:previous');
  finishCapture({ ok: false, json: async () => ({ error: 'Device capture failed' }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.src, 'blob:previous');
  assert.match(status.textContent, /Device capture failed/);
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  finishCapture({ ok: false, json: async () => ({ error: 'Device capture failed' }) });
});

test('input waits for a pending capture and then requests a new frame', async () => {
  const html = await readFile(new URL('../src/console.html', import.meta.url), 'utf8');
  const requests = [], frames = [];
  let tick, finishCapture;
  const screen = {};
  const status = { textContent: 'Loading device screen…' };
  const context = vm.createContext({
    document: { querySelector: (selector) => selector === '#screen' ? screen : selector === '#status' ? status : {}, querySelectorAll: () => [] },
    setInterval: (callback) => { tick = callback; }, Date, Math, Promise, AbortSignal,
    URL: { createObjectURL: () => `blob:${frames.length}`, revokeObjectURL() {} },
    createImageBitmap: async (blob) => { frames.push(blob); return { width: 1080, height: 2400, close() {} }; },
    fetch: async (url) => {
      requests.push(url.split('?')[0]);
      if (url === 'action') return { json: async () => ({ kind: 'key' }) };
      return new Promise((resolve) => { finishCapture = resolve; });
    },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const input = vm.runInContext("action({kind:'key',key:'BACK'})", context);
  tick();
  assert.deepEqual(requests, ['screen']);
  finishCapture({ ok: true, blob: async () => 'before input' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['screen', 'action', 'screen']);
  assert.equal(screen.src, 'blob:1');
  tick();
  assert.equal(requests.length, 3);
  finishCapture({ ok: true, blob: async () => 'after input' });
  await input;
  assert.deepEqual(frames, ['before input', 'after input']);
  assert.equal(screen.src, 'blob:2');
  assert.match(status.textContent, /Sent key/);
});

test('invalid image data leaves the previous frame available', async () => {
  const html = await readFile(new URL('../src/console.html', import.meta.url), 'utf8');
  const screen = { src: 'blob:previous' }, status = {};
  const context = vm.createContext({
    document: { querySelector: (selector) => selector === '#screen' ? screen : selector === '#status' ? status : {}, querySelectorAll: () => [] },
    setInterval() {}, Date, Math, Promise, AbortSignal,
    fetch: async () => ({ ok: true, blob: async () => ({}) }),
    createImageBitmap: async () => { throw new Error('Invalid PNG'); },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screen.src, 'blob:previous');
  assert.equal(status.textContent, 'Invalid PNG');
});

test('the local console sends visible user input to the owned device and records it', async () => {
  const results = await mkdtemp(path.join(tmpdir(), 'android-console-'));
  const calls = [];
  const png = Buffer.alloc(24); png.writeUInt32BE(1080, 16); png.writeUInt32BE(2400, 20);
  const console = await startComputerConsole({ results, appId: 'org.example.notes', adb: async (...args) => { calls.push(args); return png; } });
  try {
    const page = await fetch(console.url);
    assert.match(await page.text(), /Android device screen/);
    const response = await fetch(`${console.url}action`, { method: 'POST', headers: { Origin: new URL(console.url).origin }, body: JSON.stringify({ kind: 'tap', x: 100, y: 200 }) });
    assert.equal(response.status, 200);
    assert.ok(calls.some((args) => args.join(' ') === 'shell input tap 100 200'));
    assert.match(await readFile(path.join(results, 'actions.jsonl'), 'utf8'), /"kind":"tap"/);
    assert.equal((await fetch(new URL('/screen', console.url))).status, 404);
    const outside = await fetch(`${console.url}action`, { method: 'POST', headers: { Origin: 'https://unrelated.example' }, body: '{}' });
    assert.equal(outside.status, 403);
  } finally { await console.stop(); await rm(results, { recursive: true, force: true }); }
});

test('production consoles reject fixture/reset controls and invalid input without touching the app', async () => {
  const results = await mkdtemp(path.join(tmpdir(), 'android-console-'));
  const calls = [];
  const png = Buffer.alloc(24); png.writeUInt32BE(1080, 16); png.writeUInt32BE(2400, 20);
  const console = await startComputerConsole({ results, appId: 'org.example.notes', adb: async (...args) => { calls.push(args); return png; } });
  try {
    await fetch(`${console.url}screen`);
    const previous = calls.length;
    for (const action of [{ kind: 'reset' }, { kind: 'fixture', fixture: 'mid-workout' }, { kind: 'tap', x: -1, y: 100 }, { kind: 'key', key: 'unknown' }, { kind: 'text', text: 'a; command' }]) {
      const response = await fetch(`${console.url}action`, { method: 'POST', headers: { Origin: new URL(console.url).origin }, body: JSON.stringify(action) });
      assert.equal(response.status, 400);
    }
    assert.equal(calls.length, previous);
    const captured = await fetch(`${console.url}action`, { method: 'POST', headers: { Origin: new URL(console.url).origin }, body: JSON.stringify({ kind: 'capture' }) });
    const { evidence } = await captured.json();
    assert.deepEqual(await readFile(path.join(results, evidence)), png);
  } finally { await console.stop(); await rm(results, { recursive: true, force: true }); }
});

test('a partly applied action and its successful retry remain separate in the evidence', async () => {
  const results = await mkdtemp(path.join(tmpdir(), 'android-console-'));
  let launches = 0;
  const console = await startComputerConsole({ results, appId: 'org.example.notes', adb: async (...args) => {
    if (args.includes('start') && launches++ === 0) throw new Error('Launch failed after force-stop');
    return Buffer.from(args.includes('resolve-activity') ? 'org.example.notes/.Launcher' : '');
  } });
  try {
    const send = () => fetch(`${console.url}action`, { method: 'POST', headers: { Origin: new URL(console.url).origin }, body: JSON.stringify({ kind: 'restart' }) });
    assert.equal((await send()).status, 400);
    assert.equal((await send()).status, 200);
    const records = (await readFile(path.join(results, 'actions.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map(({ status }) => status), ['started', 'failed', 'started', 'succeeded']);
    assert.equal(records[0].actionId, records[1].actionId);
    assert.equal(records[2].actionId, records[3].actionId);
    assert.notEqual(records[0].actionId, records[2].actionId);
    assert.match(records[1].error, /Launch failed/);
    assert.ok(records.every(({ at, kind }) => Number.isFinite(Date.parse(at)) && kind === 'restart'));
  } finally { await console.stop(); await rm(results, { recursive: true, force: true }); }
});
