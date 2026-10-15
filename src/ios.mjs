// Copyright 2026 Sam Wiskow
// SPDX-License-Identifier: Apache-2.0
export function createIosDevice({ url, sessionId, appId, fetch: request = fetch }) {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('Use a loopback Appium server.');
  let geometry;
  const command = async (method, route, body) => {
    const response = await request(`${url}/session/${encodeURIComponent(sessionId)}${route}`, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(result.value?.message ?? 'iOS device command failed.');
    return result.value;
  };
  const execute = (script, args) => command('POST', '/execute/sync', { script: `mobile: ${script}`, args: [args] });
  const point = (x, y) => {
    if (!geometry) throw new Error('Capture the iOS screen before sending input.');
    return { x: x / geometry.scale - geometry.x, y: y / geometry.scale - geometry.y };
  };
  return {
    async screenshot() {
      const image = Buffer.from(await command('GET', '/screenshot'), 'base64');
      const { scale } = await execute('deviceScreenInfo', {});
      const { rect: { x, y } } = await execute('source', { format: 'json' });
      geometry = { scale, x, y };
      return image;
    },
    tap: (x, y) => execute('tap', point(x, y)),
    swipe: (x, y, toX, toY) => execute('dragFromToForDuration', {
      duration: 0.4, fromX: point(x, y).x, fromY: point(x, y).y,
      toX: point(toX, toY).x, toY: point(toX, toY).y,
    }),
    async text(text) {
      const element = await command('GET', '/element/active');
      const id = element['element-6066-11e4-a52e-4f735466cecf'];
      await command('POST', `/element/${encodeURIComponent(id)}/value`, { text });
    },
    async key(key) {
      if (key === 'HOME') return execute('pressButton', { name: 'home' });
      if (key === 'ENTER' || key === 'DEL') {
        const element = await command('GET', '/element/active');
        return command('POST', `/element/${encodeURIComponent(element['element-6066-11e4-a52e-4f735466cecf'])}/value`, { text: key === 'ENTER' ? '\uE007' : '\uE003' });
      }
      throw new Error('iOS has no Android Back or Recent apps key. Use the visible iOS controls.');
    },
    async restart() {
      await execute('terminateApp', { bundleId: appId });
      await execute('launchApp', { bundleId: appId });
    },
  };
}
