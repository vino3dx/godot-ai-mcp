# T13 Native Editor Status

The EditorPlugin/TCP Bridge is infrastructure only. It currently supports the intended `project_capabilities` request shape, but real Godot Editor verification is still blocked.

Not implemented:

- live Editor SceneTree inspection
- live Node/Resource object references
- Node property writes
- Owner, signal, group, and scene-save operations
- Editor Undo/Redo integration

Acceptance requires separate Godot Standard and Godot .NET runs. A Standard result must never be reused as .NET evidence.
