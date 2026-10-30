# T13 Implementation Plan

## Status vocabulary

- `IMPLEMENTED`: code exists.
- `UNIT_TESTED`: automated tests cover the behavior.
- `INTEGRATION_TESTED`: components were exercised together.
- `ENGINE_VERIFIED`: real Godot Editor/Runtime evidence exists.
- `BLOCKED`: required engine/environment is unavailable.
- `NOT_IMPLEMENTED`: no implementation exists.

## Current plan

1. T13-A1/A2: reuse `GodotApiService` and the engine `extension_api.json` cache for ClassDB metadata. Extend only when the actual dump provides evidence; do not invent hint/usage/default values.
2. T13-A3: extend `ScriptService` for GDScript annotations, signals, enums, constants, method parameters, return types, and custom-class relationships. Implemented and unit-tested.
3. T13-A4: use `GdscriptProjectService` for a disk-context project graph covering class inheritance, preload/load, node paths, script bindings, and static/dynamic signal relations. Implemented and unit-tested; engine verification is not applicable.
4. T13-A5: extend the engine-dump model and expose class metadata queries, retaining direct/inherited member provenance. Implemented and unit-tested; real engine verification is blocked by missing Standard/.NET installations.
5. T13-B: Native Editor scene/node operations remain blocked until Standard and .NET Bridge verification is available.
6. T13-C: UI semantics continue to use static File results plus runtime layout probes until Native Editor access is verified.
7. T13-D: Inspect/Plan/Apply/Verify workflow follows after Native read-back exists.

## Current evidence

- File Layer is implemented and covered by unit tests.
- Native Bridge code exists, but has no real-engine verification in the current environment.
- Godot Standard and Godot .NET executables are not installed in the current environment.
- No Native Editor capability is declared complete until both editions are tested independently.
