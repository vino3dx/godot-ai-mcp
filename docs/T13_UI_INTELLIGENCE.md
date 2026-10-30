# T13 UI Intelligence

The current UI capability is split by context:

- `disk`: `scene_set_ui_layout` writes serialized Control properties.
- `runtime`: `runtime_inspect_ui` measures actual post-layout rectangles and reports layout issues.
- `editor`: Native Editor Control inspection is not implemented and is blocked on Bridge verification.

Container semantics, Theme inspection, and editor-side layout writes must not be inferred from static text alone.
