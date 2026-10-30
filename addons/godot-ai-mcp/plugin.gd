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
var dock: Control
var status_label: Label
var status_icon: Label
var details_label: Label
var language_select: OptionButton
var reconnect_button: Button
var language := "zh"
const MENU_STATUS := "GodotAIMCP / Bridge Status"
const MENU_PROJECT_PATH := "GodotAIMCP / Copy Project Path"
const MENU_DASHBOARD := "GodotAIMCP / Open Dashboard"

func _enter_tree() -> void:
	_build_dashboard()
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, dock)
	add_tool_menu_item(MENU_STATUS, Callable(self, "_menu_status"))
	add_tool_menu_item(MENU_PROJECT_PATH, Callable(self, "_menu_project_path"))
	add_tool_menu_item(MENU_DASHBOARD, Callable(self, "_toggle_dashboard"))
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
	remove_tool_menu_item(MENU_STATUS)
	remove_tool_menu_item(MENU_PROJECT_PATH)
	remove_tool_menu_item(MENU_DASHBOARD)
	if dock:
		remove_control_from_docks(dock)
		dock.queue_free()
		dock = null
	if peer:
		peer.disconnect_from_host()
		peer = null
	server.stop()
	if descriptor_path != "":
		DirAccess.remove_absolute(descriptor_path)

func _menu_status() -> void:
	var state := "running" if server.is_listening() else "stopped"
	if status_label:
		status_label.text = "Bridge: %s" % state.capitalize()
		_update_dashboard()

func _menu_project_path() -> void:
	DisplayServer.clipboard_set(ProjectSettings.globalize_path("res://"))

func _toggle_dashboard() -> void:
	if dock:
		dock.visible = not dock.visible

func _build_dashboard() -> void:
	dock = VBoxContainer.new()
	dock.name = "GodotAIMCP"
	dock.custom_minimum_size = Vector2(320, 240)
	var title := Label.new()
	title.text = "GodotAIMCP"
	title.add_theme_font_size_override("font_size", 18)
	dock.add_child(title)
	var language_row := HBoxContainer.new()
	dock.add_child(language_row)
	var language_caption := Label.new()
	language_caption.text = "语言 / Language"
	language_row.add_child(language_caption)
	language_select = OptionButton.new()
	language_select.add_item("简体中文")
	language_select.add_item("English")
	language_select.add_item("日本語")
	language_select.add_item("한국어")
	language_select.item_selected.connect(_on_language_selected)
	language_row.add_child(language_select)
	var status_row := HBoxContainer.new()
	dock.add_child(status_row)
	status_icon = Label.new()
	status_icon.add_theme_font_size_override("font_size", 22)
	status_row.add_child(status_icon)
	status_label = Label.new()
	status_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	status_row.add_child(status_label)
	reconnect_button = Button.new()
	reconnect_button.pressed.connect(_reconnect_bridge)
	status_row.add_child(reconnect_button)
	details_label = Label.new()
	details_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	dock.add_child(details_label)
	var tabs := TabContainer.new()
	tabs.size_flags_vertical = Control.SIZE_EXPAND_FILL
	dock.add_child(tabs)
	var service := RichTextLabel.new()
	service.bbcode_enabled = true
	service.text = "[b]MCP Service[/b]\nPackage: vino-godot-mcp\nStatus: use npx -y for zero-install startup\nInstall/check: npm i vino-godot-mcp\nConfig: npx -y vino-godot-mcp\n\nGODOT_PATH and GODOT_PROJECT_PATH must point to this Godot installation and project.\nThe service reads .godot-ai-mcp/bridge.json while the editor is open."
	tabs.add_child(service)
	tabs.set_tab_title(0, "MCP Service")
	var docs := RichTextLabel.new()
	docs.bbcode_enabled = true
	docs.text = "[b]Quick start[/b]\n1. Enable GodotAIMCP.\n2. Keep the editor open.\n3. Set GODOT_PROJECT_PATH to this project.\n4. Call project_capabilities from MCP."
	tabs.add_child(docs)
	tabs.set_tab_title(1, "Documentation")
	_update_dashboard()

func _on_language_selected(index: int) -> void:
	language = ["zh", "en", "ja", "ko"][index]
	_update_dashboard()

func _reconnect_bridge() -> void:
	if peer:
		peer.disconnect_from_host()
		peer = null
	if server.is_listening():
		server.stop()
	var err := server.listen(port, "127.0.0.1")
	if err != OK:
		push_error("GodotAIMCP reconnect failed: %s" % error_string(err))
	_update_dashboard()

func _text(key: String) -> String:
	var translations := {
		"zh": {"working": "godot-ai-mcp 正在工作", "stopped": "godot-ai-mcp 未连接", "reconnect": "重新连接", "details": "Godot：%s\n项目：%s\n路径：%s\n地址：127.0.0.1\n端口：%d\n协议：%d\nSession：%s"},
		"en": {"working": "godot-ai-mcp is working", "stopped": "godot-ai-mcp disconnected", "reconnect": "Reconnect", "details": "Godot: %s\nProject: %s\nPath: %s\nHost: 127.0.0.1\nPort: %d\nProtocol: %d\nSession: %s"},
		"ja": {"working": "godot-ai-mcp は動作中です", "stopped": "godot-ai-mcp は未接続です", "reconnect": "再接続", "details": "Godot：%s\nプロジェクト：%s\nパス：%s\nホスト：127.0.0.1\nポート：%d\nプロトコル：%d\nセッション：%s"},
		"ko": {"working": "godot-ai-mcp 작동 중", "stopped": "godot-ai-mcp 연결 안 됨", "reconnect": "다시 연결", "details": "Godot: %s\n프로젝트: %s\n경로: %s\n호스트: 127.0.0.1\n포트: %d\n프로토콜: %d\n세션: %s"}
	}
	return translations.get(language, translations["zh"]).get(key, key)

func _update_dashboard() -> void:
	if not status_label or not details_label:
		return
	var working := server.is_listening()
	status_icon.text = "✓" if working else "✕"
	status_icon.add_theme_color_override("font_color", Color("65d681") if working else Color("ed6a6a"))
	status_label.text = _text("working" if working else "stopped")
	reconnect_button.text = _text("reconnect")
	details_label.text = _text("details") % [Engine.get_version_info().get("string", "unknown"), ProjectSettings.get_setting("application/config/name", "unknown"), ProjectSettings.globalize_path("res://"), port, PROTOCOL_VERSION, session_id]

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
