# T13 Architecture

```text
Agent workflow
  -> MCP Tool / ToolHost
  -> context-aware Service
  -> Native Layer (Editor/Runtime) or File Layer (Disk)
  -> Godot Engine / project files
```

Every result must identify its context: `editor`, `runtime`, or `disk`.

Class metadata and object state are different:

- `GodotApiService` describes ClassDB metadata from an engine dump.
- A future Native service will describe a live Node/Resource instance.
- A parsed `.tscn`/`.tres` describes disk state only.

Native object references must be scoped to a Bridge session. Godot instance IDs are not cross-session permanent identifiers.

The current implementation does not yet merge these channels or expose Native Scene/Node write operations.
