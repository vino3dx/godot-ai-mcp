import { test } from "node:test";
import assert from "node:assert/strict";
import { InputMapService } from "../src/services/inputMapService.js";
import { ProjectService } from "../src/services/projectService.js";

const PROJECT = `[application]\nconfig/name="Input"\n\n[input]\n\nmove={\n"deadzone": 0.2,\n"events": [Object(InputEventKey,"device":0,"physical_keycode":65,"pressed":false), Object(InputEventMouseButton,"button_index":1,"pressed":false)]\n}\n\njoy={\n"deadzone": 0.5,\n"events": [Object(InputEventJoypadButton,"device":1,"button_index":0), Object(InputEventJoypadMotion,"device":1,"axis":0,"axis_value":1.0)]\n}\n\nunknown={\n"deadzone": 0.5,\n"events": [Object(InputEventCustom,"value":7)]\n}\n`;
const service = new InputMapService(new ProjectService());

test("Input Map get decodes four supported event types and preserves unknown", () => {
  const actions = service.get(PROJECT);
  assert.equal(actions.length, 3);
  assert.deepEqual(actions[0]!.events.map((e) => e.type), ["InputEventKey", "InputEventMouseButton"]);
  assert.equal(actions[0]!.events[0]!.fields["physical_keycode"], 65);
  assert.deepEqual(actions[1]!.events.map((e) => e.type), ["InputEventJoypadButton", "InputEventJoypadMotion"]);
  assert.equal(actions[2]!.events[0]!.known, false);
  assert.match(actions[2]!.events[0]!.raw, /InputEventCustom/);
  assert.equal(service.get(PROJECT, "move").length, 1);
});

test("Input Map update adds action, changes deadzone, adds/removes/replaces events and verifies", () => {
  let text = service.update(PROJECT, { operation: "set_deadzone", action: "move", deadzone: 0.7 }).text;
  text = service.update(text, { operation: "add_event", action: "move", event: { type: "InputEventKey", physicalKeycode: 32 } }).text;
  assert.equal(service.get(text, "move")[0]!.events.length, 3);
  text = service.update(text, { operation: "replace_event", action: "move", eventIndex: 2, event: { type: "InputEventMouseButton", buttonIndex: 2 } }).text;
  text = service.update(text, { operation: "remove_event", action: "move", eventIndex: 2 }).text;
  assert.equal(service.get(text, "move")[0]!.deadzone, 0.7);
  text = service.update(text, { operation: "add_action", action: "jump", deadzone: 0.1, event: { type: "InputEventKey", keycode: 32 } }).text;
  assert.equal(service.get(text, "jump")[0]!.events[0]!.type, "InputEventKey");
  assert.throws(() => service.update(text, { operation: "add_event", action: "move", event: { type: "InputEventKey", physicalKeycode: 65 } }), /已存在/);
  assert.throws(() => service.update(text, { operation: "remove_event", action: "move", eventIndex: 99 }), /索引不存在/);
  assert.throws(() => service.update(text, { operation: "add_event", action: "move", event: { type: "InputEventKey", unknown: 1 } as never }), /属性不支持/);
});
