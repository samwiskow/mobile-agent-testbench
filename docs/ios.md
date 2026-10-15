# iOS console API

The Android CLI remains the default. iOS control is an optional library API for
a caller that owns a signed Appium XCUITest session on macOS. Android users do
not need Appium or Xcode.

```js
import { startComputerConsole } from '@samwiskow/mobile-agent-testbench';
import { createIosDevice } from '@samwiskow/mobile-agent-testbench/ios';
import { withIosSession } from '@samwiskow/mobile-agent-testbench/ios-session';

await withIosSession(async () => {
  // Start your Appium session after acquiring ownership and stop it in finally.
  const device = createIosDevice({
    url: 'http://127.0.0.1:4727', sessionId, appId: 'org.example.test',
  });
  const console = await startComputerConsole({
    platform: 'ios', device, appId: 'org.example.test', results: './evidence',
  });
  // Keep the owner alive while the operator uses console.url; await console.stop().
}, { udid: 'YOUR-EXACT-DEVICE-UDID' });
```

The caller configures Appium with PNG screenshots (`screenshotQuality: 0`). The
adapter uses the device screen scale and active application's origin to convert
Retina screenshot pixels to app-relative device points. It provides tap, swipe, focused-field text, Home, Enter, Delete, and
terminate/relaunch for the configured bundle. Use visible navigation controls
for Back and the app switcher. The existing attempt, failure, and screenshot
records are retained. Only loopback Appium servers are accepted.

Real devices need Developer Mode, UI Automation, and a signed WebDriverAgent.
Free Personal Teams can sign the helper; their provisioning expires after seven
days. Appium installation, helper signing, app fixtures, accessibility settings,
and acceptance decisions remain the caller's responsibility. An occupied device
lock is never removed automatically; inspect its owner first.
