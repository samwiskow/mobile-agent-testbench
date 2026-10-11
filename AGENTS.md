# Working on Mobile Agent Testbench

Keep the tool Android-only and browser-based until another platform is explicitly
requested. Keep application fixtures and release policies in consuming projects.

Use the shared device session for all manual Android commands. Pass the owned
serial to ADB. Never stop a device, emulator or process owned by another task.

Test changed behaviour through the HTTP interface, CLI or exported session APIs.
Mock only ADB/emulator process boundaries. Run `npm test`, `npm pack --dry-run`
and `git diff --check` before handoff. Record native verification separately.

Preserve Apache-2.0 notices. Do not add runtime dependencies without a concrete
need. Use conventional commits and isolated branches for subsequent changes.
