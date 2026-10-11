# Initial extraction verification

Date: 11 October 2026.

## Automated checks

25 Node tests pass on macOS with Node 24.14.0. They cover browser coordinate
mapping, capture serialization, HTTP actions and evidence, unrelated app launch,
optional project setup controls, CLI device selection, lock ownership, temporary
emulator allocation, cancellation and terminal-hangup cleanup.

A new launcher test first failed because restart assumed `.MainActivity`.
It passes with Android launcher discovery. A terminal-hangup test first left the
owned command and lock behind; it passes after SIGHUP is handled as cancellation.

`npm pack` produces the standalone package with its browser page, CLI, modules,
README, Apache-2.0 licence and notices. There are no runtime npm dependencies.

## Native browser check

A temporary read-only Pixel 7a emulator ran Android 17/API 37, 1080 × 2400,
420 dpi and font scale 1.0. The AVD inherited TalkBack settings; these were disabled
only in the disposable instance before the standard-touch check.

Using the browser console against `com.android.settings`:

- Restart opened the native Settings launcher activity.
- A tap opened Settings search.
- Text input entered `display` and produced visible search results.
- Back dismissed the native keyboard.
- A swipe scrolled the search results.
- Save screenshot wrote a PNG and linked it from the action record.
- Stopping the console closed its HTTP server and recorded `stopped` in run.json.

![Browser console controlling native Android Settings](android-console.png)

An initial terminal interruption exposed the hangup cleanup gap described above.
Its orphaned processes were stopped and its exact abandoned locks removed after
confirming that the owner had exited. A separate setup attempt failed because
Android rejected an empty settings value; using `settings delete` corrected the
disposable test setup. Failed attempts were retained locally.

These checks verify the control tool. They are emulator evidence, not physical
Android acceptance or an application's release sign-off. iOS and Windows are
not supported by this version. GitHub CI also checks Node 22 and 24 on Linux and
macOS; its result must be read separately from these local checks.
