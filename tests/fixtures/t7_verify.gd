extends SceneTree

# T7 真实引擎验证脚本(4.6.3 实测跑通)。
#
# 由 tests/sceneReadTools.real.test.ts 拷进临时工程,以
#   --headless --path <tmp> --script <tmp>/t7_verify.gd -- --scene res://scenes/engine_saved.tscn
# 运行。所有输出以 `T7RESULT ` 前缀打到 stdout,由 TS 侧解析。
#
# 目的:把工具的读侧结果与**引擎自身的类信息**对齐(不是与另一份我们自己的解析对齐):
#   - class/prop/sig/const 行来自引擎的 ClassDB;
#   - conn/inst 行来自引擎真实加载一个**引擎自己写出**的场景(见 tests/fixtures/t6_engine_saved.tscn)。
#
# 注意:ClassDB.class_get_property_list(cls, true) 的第二个参数是 no_inheritance —— 取"本类自身声明"的
# 成员,与工具体系里 scene_get_node_info 的语义一致(继承链单独给出)。

const CLASSES := ["Node2D", "CharacterBody2D", "Sprite2D", "Control", "AnimationPlayer"]

var _scene_path := "res://scenes/engine_saved.tscn"

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var i := 0
	while i < args.size():
		if args[i] == "--scene" and i + 1 < args.size():
			i += 1
			_scene_path = args[i]
		i += 1

	for cls in CLASSES:
		_report_class(cls)
	_report_scene()
	print("T7RESULT ok")
	quit(0)

# ────────────────────────────── ClassDB ──────────────────────────────

func _report_class(cls: String) -> void:
	var parent: StringName = ClassDB.get_parent_class(cls)
	var props := ClassDB.class_get_property_list(cls, true)
	var sigs := ClassDB.class_get_signal_list(cls, true)
	var consts := ClassDB.class_get_integer_constant_list(cls, true)
	print("T7RESULT class|%s|parent=%s|instantiable=%s|ownProps=%d|ownSignals=%d" % [
		cls, str(parent), str(ClassDB.can_instantiate(cls)), props.size(), sigs.size(),
	])
	# 完整继承链(父类 → Object),由引擎逐级 get_parent_class 得到
	var chain := PackedStringArray()
	var cur: StringName = parent
	while cur != &"":
		chain.append(str(cur))
		cur = ClassDB.get_parent_class(cur)
	print("T7RESULT chain|%s|%s" % [cls, ",".join(chain)])
	for p in props:
		var prop_name := str(p["name"])
		print("T7RESULT prop|%s|%s|%s" % [cls, prop_name, _type_of(p)])
		var hint := str(p["hint_string"])
		if hint != "":
			print("T7RESULT hint|%s|%s|%s" % [cls, prop_name, hint])
	for s in sigs:
		var arg_list := PackedStringArray()
		for a in s["args"]:
			arg_list.append(str(a["name"]) + ":" + _type_of(a))
		print("T7RESULT sig|%s|%s|%s" % [cls, str(s["name"]), ",".join(arg_list)])
	for c in consts:
		print("T7RESULT const|%s|%s|%s" % [cls, str(c), str(ClassDB.class_get_integer_constant(cls, c))])

# 属性的"有效类型名",口径与 extension_api.json 一致(否则两边没法逐项对比):
#   - 对象类型写具体类名(ClassDB 的 PropertyInfo 只给 TYPE_OBJECT + class_name,而 dump 写 "Texture2D");
#   - 带元素类型的数组写 "typedarray::<Element>"(dump 的写法),否则写 "Array";
#   - 其余用 Variant.Type 的名字(type_string)。
func _type_of(p: Dictionary) -> String:
	var t := int(p["type"])
	var cls_name := str(p.get("class_name", ""))
	if t == TYPE_OBJECT:
		if cls_name != "":
			return cls_name
		return "Object"
	if t == TYPE_ARRAY:
		if cls_name != "":
			return "typedarray::" + cls_name
		# 带元素类型的数组在运行时 PropertyInfo 里靠 hint 表达(PROPERTY_HINT_ARRAY_TYPE + hint_string)
		if int(p["hint"]) == PROPERTY_HINT_ARRAY_TYPE and str(p["hint_string"]) != "":
			return "typedarray::" + str(p["hint_string"])
		return "Array"
	return type_string(t)

# ────────────────────── 场景:引擎写出的连接与实例 ──────────────────────

func _report_scene() -> void:
	var packed: PackedScene = load(_scene_path)
	if packed == null:
		push_error("T7_SCENE_LOAD_FAILED: " + _scene_path)
		quit(4)
		return
	var root: Node = packed.instantiate()
	_walk(root, root)
	print("T7RESULT scene_ok")
	# 读完之后显式释放:否则 CharacterBody2D 的物理 RID 会在退出时被引擎报成 ERROR(泄漏)。
	root.free()

func _rel(node: Node, scene_root: Node) -> String:
	if node == scene_root:
		return "."
	var rel: String = String(scene_root.get_path_to(node))
	return rel if rel != "" else "."

func _walk(node: Node, scene_root: Node) -> void:
	print("T7RESULT node|" + _rel(node, scene_root) + "|" + node.get_class())
	if node.scene_file_path != "":
		print("T7RESULT inst|" + _rel(node, scene_root) + "|" + node.scene_file_path)
	for sig in node.get_signal_list():
		var sig_name: String = str(sig["name"])
		for conn in node.get_signal_connection_list(sig_name):
			var cb: Callable = conn["callable"]
			var target: Object = cb.get_object()
			var target_path := "?"
			if target is Node:
				target_path = _rel(target, scene_root)
			print("T7RESULT conn|" + _rel(node, scene_root) + "|" + sig_name + "|" + target_path + "|" + str(cb.get_method()) + "|" + str(conn["flags"]))
	for child in node.get_children():
		_walk(child, scene_root)
