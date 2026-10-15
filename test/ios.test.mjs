// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIosDevice } from '../src/ios.mjs';

test('iOS screen taps use device points rather than Retina screenshot pixels', async () => {
  const png = Buffer.alloc(24); png.writeUInt32BE(1640, 16); png.writeUInt32BE(2360, 20);
  const calls = [];
  const device = createIosDevice({ url: 'http://127.0.0.1:4727', sessionId: 'test', appId: 'org.example.notes', fetch: async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body ?? '{}') });
    return { ok: true, json: async () => ({ value: url.endsWith('/screenshot') ? png.toString('base64') : calls.at(-1).script === 'mobile: source' ? { rect: { x: 0, y: 0, width: 820, height: 1180 } } : { scale: 2 } }) };
  } });
  await device.screenshot();
  await device.tap(820, 1180);
  assert.deepEqual(calls.at(-1).args, [{ x: 410, y: 590 }]);
  assert.equal(calls.at(-1).script, 'mobile: tap');
});

test('iPad floating-window taps keep the screen scale and subtract the app origin', async () => {
  const png = Buffer.alloc(24); png.writeUInt32BE(2360, 16); png.writeUInt32BE(1640, 20);
  const calls = [];
  const device = createIosDevice({ url: 'http://127.0.0.1:4727', sessionId: 'test', fetch: async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body ?? '{}') });
    return { ok: true, json: async () => ({ value: url.endsWith('/screenshot') ? png.toString('base64') : calls.at(-1).script === 'mobile: source' ? { rect: { x: 151, y: 163, width: 877, height: 486 } } : { scale: 2 } }) };
  } });
  await device.screenshot();
  await device.tap(1514, 1530);
  assert.deepEqual(calls.at(-1).args, [{ x: 606, y: 602 }]);
});

test('iOS entry and restart use the focused field and only the configured app', async () => {
  const calls = [];
  const device = createIosDevice({ url: 'http://127.0.0.1:4727', sessionId: 'test', appId: 'org.example.notes', fetch: async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body ?? '{}') });
    return { ok: true, json: async () => ({ value: url.endsWith('/element/active') ? { 'element-6066-11e4-a52e-4f735466cecf': 'focused' } : null }) };
  } });
  await device.text('79.5');
  assert.ok(calls[1].url.endsWith('/element/focused/value'));
  assert.equal(calls[1].text, '79.5');
  await device.key('DEL');
  assert.ok(calls.at(-1).url.endsWith('/element/focused/value'));
  assert.equal(calls.at(-1).text, '\uE003');
  await device.key('ENTER');
  assert.equal(calls.at(-1).text, '\uE007');
  await device.restart();
  assert.deepEqual(calls.slice(-2).map(({ script, args }) => ({ script, args })), [
    { script: 'mobile: terminateApp', args: [{ bundleId: 'org.example.notes' }] },
    { script: 'mobile: launchApp', args: [{ bundleId: 'org.example.notes' }] },
  ]);
  await assert.rejects(device.key('BACK'), /visible iOS controls/);
});

test('iOS device errors are reported and remote control servers are rejected', async () => {
  assert.throws(() => createIosDevice({ url: 'https://example.com', sessionId: 'test' }), /loopback/);
  const device = createIosDevice({ url: 'http://127.0.0.1:4727', sessionId: 'test', fetch: async () => ({ ok: false, json: async () => ({ value: { error: 'invalid session id', message: 'The iPad session ended' } }) }) });
  await assert.rejects(device.screenshot(), /The iPad session ended/);
});
