# T13 Class and GDScript Intelligence

## ClassDB

`GodotApiService` loads and caches the engine's `extension_api.json`. It currently exposes class name, inheritance, instantiability, properties, signals, and enum associations where the dump proves them.

T13-A5 extends the imported model with methods, method arguments/defaults when present, property getter/setter names, constants, and direct-versus-inherited member views. The model retains `engine_dump` verification status and cache/version provenance.

The dump does not reliably contain property `hint`, `hint_string`, `usage`, or default values. These fields must remain absent rather than guessed.

The new `class_get_info`, `class_search`, and `class_validate_member` tools expose metadata queries. They do not represent live Editor objects and require an engine dump; with no Godot executable they return the existing structured `GODOT_NOT_FOUND` error.

## GDScript static analysis

`ScriptService` now returns:

- `extends` and `class_name`
- script annotations such as `@tool`, `@icon`, and `@static_unload`
- exported variables and their annotations
- signals and parameter declarations
- enums and explicit values
- constants, types, and values
- top-level functions, static status, parameters, defaults, and return types
- existing variables and symbol locations

Static results are not engine load results. Script validity, custom class registration, and actual Node binding still require Godot verification.

## Project graph

`GdscriptProjectService` aggregates the existing script and scene parsers into a disk-context graph. It records inheritance, `preload`/`load`, `$NodePath`, `%UniqueName`, `get_node`, `@onready`, script bindings, signal definitions/emits/connects/disconnects, and serialized scene connections. Every relation carries source, target, relation type, source location, confidence, context, and resolution status. Dynamic expressions are explicitly marked `dynamic`/`unknown`; they are not presented as engine facts.
