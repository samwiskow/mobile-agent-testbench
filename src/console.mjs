// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

export async function startComputerConsole({ adb, results, appId, setupActions = [] }) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(appId ?? '')) throw new Error('A valid Android app package is required.');
  await mkdir(results, { recursive: true });
  const base = '/' + randomUUID() + '/';
  const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const controls = setupActions.map(({ id, label }) => `<button data-setup="${escape(id)}">${escape(label)}</button>`).join(' ');
  const html = (await readFile(new URL('./console.html', import.meta.url), 'utf8')).replace('__SETUP_CONTROLS__',
    controls ? `<details><summary>Declared test setup only</summary>${controls}</details>` : '');
  let screen;
  let queue = Promise.resolve();
  const server = createServer((request, response) => {
    queue = queue.catch(() => {}).then(async () => {
      if (request.aborted || response.destroyed) return;
      if (!request.url.startsWith(base)) { response.writeHead(404).end(); return; }
      response.setHeader('Cache-Control', 'no-store');
      let action;
      let actionId;
      const record = (status, error) => appendFile(path.join(results, 'actions.jsonl'), `${JSON.stringify({ ...action, actionId, at: new Date().toISOString(), status, ...(error ? { error } : {}) })}\n`);
      try {
        const route = request.url.slice(base.length).split('?')[0];
        if (request.method === 'GET' && route === '') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
        if (request.method === 'GET' && route === 'screen') {
          screen = await adb('exec-out', 'screencap', '-p');
          response.setHeader('Content-Type', 'image/png'); response.end(screen); return;
        }
        if (request.method !== 'POST' || route !== 'action') { response.writeHead(404).end(); return; }
        if (request.headers.origin !== `http://127.0.0.1:${server.address().port}`) { response.writeHead(403).end(); return; }
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error('Input is too long.'); }
        action = JSON.parse(body);
        actionId = randomUUID();
        await record('started');
        const coordinate = (value, limit) => Number.isInteger(value) && value >= 0 && value < limit;
        if (['tap', 'swipe'].includes(action.kind)) {
          if (!screen) screen = await adb('exec-out', 'screencap', '-p');
          if (!coordinate(action.x, screen.readUInt32BE(16)) || !coordinate(action.y, screen.readUInt32BE(20))) throw new Error('Tap is outside the device screen.');
          if (action.kind === 'tap') await adb('shell', 'input', 'tap', String(action.x), String(action.y));
          else {
            if (!coordinate(action.toX, screen.readUInt32BE(16)) || !coordinate(action.toY, screen.readUInt32BE(20))) throw new Error('Swipe is outside the device screen.');
            await adb('shell', 'input', 'swipe', String(action.x), String(action.y), String(action.toX), String(action.toY), '400');
          }
        } else if (action.kind === 'key' && ['BACK', 'HOME', 'APP_SWITCH', 'ENTER', 'DEL'].includes(action.key)) {
          await adb('shell', 'input', 'keyevent', `KEYCODE_${action.key}`);
        } else if (action.kind === 'text' && typeof action.text === 'string' && /^[a-zA-Z0-9 .,_@+-]{1,200}$/.test(action.text)) {
          await adb('shell', 'input', 'text', action.text.replaceAll(' ', '%s'));
        } else if (action.kind === 'restart') {
          const resolved = String(await adb('shell', 'cmd', 'package', 'resolve-activity', '--brief',
            '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', appId)).trim().split(/\r?\n/).at(-1);
          if (!resolved?.startsWith(appId + '/') || !/^[a-zA-Z0-9_.$]+\/[a-zA-Z0-9_.$]+$/.test(resolved)) throw new Error('The app has no launchable activity.');
          await adb('shell', 'am', 'force-stop', appId);
          await adb('shell', 'am', 'start', '-W', '-n', resolved);
        } else if (action.kind === 'capture') {
          const file = `screen-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
          await writeFile(path.join(results, file), await adb('exec-out', 'screencap', '-p'));
          action.evidence = file;
        } else if (action.kind === 'setup' && setupActions.some(({ id }) => id === action.id)) {
          await setupActions.find(({ id }) => id === action.id).run();
        } else throw new Error('Unsupported user action.');
        await record('succeeded');
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(action));
      } catch (error) {
        if (actionId) await record('failed', error.message);
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}${base}`, stop: async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await queue.catch(() => {});
  } };
}
