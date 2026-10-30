# T13 Test Report

## Current automated evidence

- `npm run build`: passed.
- Previous full test baseline: 326 tests, 310 passed, 0 failed, 16 skipped.
- Godot-dependent tests are skipped when `GODOT_BIN` is unavailable.

## Current environment

- Godot Standard: blocked; executable not found.
- Godot .NET: blocked; executable not found.
- .NET SDK is installed, but it cannot substitute for a Godot .NET Editor.

## Required before Native acceptance

- Standard real Editor Bridge test.
- .NET real Editor Bridge test.
- SceneTree and Node read-back tests for both editions.
- UI and save/reload tests for both editions.
