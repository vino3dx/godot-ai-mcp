@tool
extends EditorPlugin

const PROTOCOL_VERSION := 1
const DEFAULT_PORT := 49731
const MAX_MESSAGE_BYTES := 1048576
var server := TCPServer.new()
var peer: StreamPeerTCP
var input := PackedByteArray()
var token := ""
var session_id := ""
var descriptor_path := ""
var port := DEFAULT_PORT

func _enter_tree() -> void:
	port = int(ProjectSettings.get_setting("godot_ai_mcp/bridge_port", DEFAULT_PORT))
	token = _random_token()
	session_id = "%s-%s" % [Time.get_unix_time_from_system(), randi()]
	var err := server.listen(port, "127.0.0.1")
	if err != OK:
		push_error("Godot AI MCP Bridge failed to listen on 127.0.0.1:%d (%s)" % [port, error_string(err)])
		return
	descriptor_path = ProjectSettings.globalize_path("res://.godot-ai-mcp/bridge.json")
	DirAccess.make_dir_recursive_absolute(descriptor_path.get_base_dir())
	_write_descriptor()

func _exit_tree() -> void:
	if peer:
		peer.disconnect_from_host()
		peer = null
	server.stop()
	if descriptor_path != "":
		DirAccess.remove_absolute(descriptor_path)

func _process(_delta: float) -> void:
	if not server.is_connection_available():
		return
	peer = server.take_connection()
	peer.set_no_delay(true)
	input = PackedByteArray()

func _random_token() -> String:
	var bytes := PackedByteArray()
	for i in 32:
		bytes.append(randi() & 255)
	return bytes.hex_encode()

func _write_descriptor() -> void:
	var f := FileAccess.open(descriptor_path, FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify({"host": "127.0.0.1", "port": port, "token": token, "sessionId": session_id, "projectPath": ProjectSettings.globalize_path("res://")}))
		f.close()

func _physics_process(_delta: float) -> void:
	if not peer or peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return
	var available := peer.get_available_bytes()
	if available > 0:
		input.append_array(peer.get_data(available)[1])
		_process_frames()

func _process_frames() -> void:
	while input.size() >= 4:
		var length := input.decode_u32(0)
		if length > MAX_MESSAGE_BYTES:
			peer.disconnect_from_host()
			return
		if input.size() < length + 4:
			return
		var parsed = JSON.parse_string(input.slice(4, length + 4).get_string_from_utf8())
		input = input.slice(length + 4)
		var response := _handle(parsed)
		var body := JSON.stringify(response).to_utf8_buffer()
		var frame := PackedByteArray()
		frame.resize(4)
		frame.encode_u32(0, body.size())
		frame.append_array(body)
		peer.put_data(frame)

func _handle(request) -> Dictionary:
	var id := str(request.get("requestId", "")) if request is Dictionary else ""
	var base := {"protocolVersion": PROTOCOL_VERSION, "requestId": id, "success": false, "error": null}
	if not request is Dictionary:
		base.error = {"code": "INVALID_JSON", "message": "Request must be a JSON object"}
		return base
	if int(request.get("protocolVersion", 0)) != PROTOCOL_VERSION:
		base.error = {"code": "UNSUPPORTED_PROTOCOL", "message": "Unsupported bridge protocol version"}
		return base
	if str(request.get("token", "")) != token:
		base.error = {"code": "UNAUTHORIZED", "message": "Invalid bridge token"}
		return base
	if str(request.get("method", "")) != "project_capabilities":
		base.error = {"code": "METHOD_NOT_FOUND", "message": "Unsupported bridge method"}
		return base
	base.success = true
	base.data = {"protocolVersion": PROTOCOL_VERSION, "godotVersion": Engine.get_version_info().get("string", "unknown"), "godotInstanceId": session_id, "bridgeSessionId": session_id, "projectPath": ProjectSettings.globalize_path("res://"), "projectId": ProjectSettings.get_setting("application/config/name", "unknown"), "editorConnected": true, "pluginRunning": true, "currentScene": _current_scene(), "nativeCapabilities": {"editor_context": true, "runtime_context": false, "disk_context": false, "scene_inspect": false, "node_inspect": false, "resource_inspect": false, "signal_inspect": false, "group_inspect": false, "scene_write": false, "resource_write": false}}
	return base

func _current_scene() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if not root:
		return {}
	return {"path": root.scene_file_path, "dirty": EditorInterface.get_edited_scene_root() != null}
