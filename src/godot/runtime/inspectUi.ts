// runtime_inspect_ui 的引擎侧与纯计算部分:
//   - INSPECT_UI_SCRIPT:临时 GDScript(加载场景 → 等帧 → 采集每个 Control 的真实布局 → 单行回传)
//   - buildInspectUiArgs:纯参数构建
//   - computeUiIssues / summarizeUiIssues:布局问题判定(容差 0.5px,纯函数,便于单测)
//
// 实测结论(真实 Godot 4.6.3,2026-10-14,本机 Windows):
//   - **headless 与非 headless 的布局数值不一致**:headless 的 root Window 恒为 64x64,
//     ProjectSettings 的 display/window/size/viewport_width|height 被忽略;
//     `get_root().size = Vector2i(w,h)` 与 `DisplayServer.window_set_size()` 在 headless 下都不生效。
//     因此 800x600 工程在 headless 下根 Control 只有 64x64,锚点/容器布局全被压扁。
//   - **字体最小尺寸两种模式一致**:Button 99x31 / Label 57x23(TextServer 都是
//     "ICU / HarfBuzz / Graphite (Built-in)"),故差异只来自视口尺寸,不来自字体度量。
//   - **窗口模式**下 DisplayServer.window_set_size(Vector2i(w,h)) 能改变视口并驱动重新布局,
//     但必须在首帧之后调用(_initialize 里直接调用无效)→ width/height 覆盖据此实现。
//   结论:本工具默认(且只能)非 headless,见 runtimeService.inspectUi。

/** 向量统一用数组,300 个节点时 JSON 体积明显小于对象形式。 */
export type UiVec2 = [number, number];
/** [x, y, w, h]。 */
export type UiRect = [number, number, number, number];

/** 引擎脚本回传的单个 Control 快照(这里只是类型声明,字段名与 GDScript 输出逐字对应)。 */
export interface InspectedControl {
  /** 相对场景根的节点路径("." = 场景根)。 */
  path: string;
  class: string;
  visible: boolean;
  visible_in_tree: boolean;
  global_rect: UiRect;
  /** 相对父节点原点的位置(Control.position)。 */
  position: UiVec2;
  size: UiVec2;
  rotation: number;
  scale: UiVec2;
  pivot_offset: UiVec2;
  /** get_combined_minimum_size():含容器与字体算出来的最小尺寸。 */
  min_size: UiVec2;
  /** 父节点相对场景根的路径;父节点在场景外(场景根的父 Window)时为 ""。 */
  parent_path: string;
  parent_is_container: boolean;
  /** 父节点是 Control 且 clip_contents 为 true。 */
  parent_clip_contents: boolean;
  /** 父 Control 的 global_rect;父节点不是 Control 时为 null(out_of_parent/clipped 无法判定)。 */
  parent_rect: UiRect | null;
}

/** 引擎脚本 print 出来的整个 payload。 */
export interface UiInspectPayload {
  scene: string;
  viewportSize: { width: number; height: number };
  /** 命中的 Control 总数(截断前)。 */
  nodeCount: number;
  truncated: boolean;
  nodes: InspectedControl[];
  /** 请求了但没能解析成 Control 的路径。 */
  missing: string[];
  engineVersion: string;
}

/** 判定容差(像素);小于该幅度的越界不算问题。 */
export const UI_ISSUE_TOLERANCE = 0.5;

export const UI_ISSUE_TYPES = [
  "out_of_parent",
  "out_of_viewport",
  "zero_size",
  "smaller_than_min",
  "clipped_by_parent",
] as const;
export type UiIssueType = (typeof UI_ISSUE_TYPES)[number];

export type UiIssueSummary = Record<UiIssueType, number>;

/** payload 的 JSON 结构自检:引擎返回了非预期形状时由调用方转成结构化错误。 */
export function isUiInspectPayload(v: unknown): v is UiInspectPayload {
  if (v === null || typeof v !== "object") return false;
  const p = v as Partial<UiInspectPayload>;
  const vp = p.viewportSize as { width?: unknown; height?: unknown } | undefined;
  return (
    typeof p.scene === "string" &&
    typeof p.engineVersion === "string" &&
    typeof p.nodeCount === "number" &&
    typeof p.truncated === "boolean" &&
    Array.isArray(p.nodes) &&
    Array.isArray(p.missing) &&
    vp !== undefined &&
    typeof vp.width === "number" &&
    typeof vp.height === "number"
  );
}

/** 等待布局稳定的帧数默认值(与截图同源:静态场景 3 帧足够)。 */
export const DEFAULT_INSPECT_FRAMES = 3;
export const MAX_INSPECT_FRAMES = 60;
export const DEFAULT_MAX_INSPECT_NODES = 300;

export interface InspectUiMode {
  /** 已写入系统临时目录的脚本绝对路径。 */
  scriptPath: string;
  scene: string;
  /** 只检查这些节点(相对场景根);空数组 = 遍历全部 Control。 */
  nodePaths: readonly string[];
  frames: number;
  width?: number;
  height?: number;
  includeHidden: boolean;
  maxNodes: number;
}

/** 构建参数:--path <project> --script <临时脚本> -- <用户参数>(用户参数由脚本用 get_cmdline_user_args 解析)。 */
export function buildInspectUiArgs(projectDir: string, m: InspectUiMode): string[] {
  const args = [
    "--path", projectDir,
    "--script", m.scriptPath,
    "--",
    "--scene", m.scene,
    "--frames", String(m.frames),
    "--max-nodes", String(m.maxNodes),
  ];
  for (const p of m.nodePaths) args.push("--node", p);
  if (m.width !== undefined) args.push("--width", String(m.width));
  if (m.height !== undefined) args.push("--height", String(m.height));
  if (m.includeHidden) args.push("--include-hidden");
  return args;
}

/** inner 是否越出 outer 边界(容差 tol 像素内不算越界)。 */
function exceeds(inner: UiRect, outer: UiRect, tol: number = UI_ISSUE_TOLERANCE): boolean {
  return (
    inner[0] < outer[0] - tol ||
    inner[1] < outer[1] - tol ||
    inner[0] + inner[2] > outer[0] + outer[2] + tol ||
    inner[1] + inner[3] > outer[1] + outer[3] + tol
  );
}

/**
 * 单个 Control 的 issues。规则(容差 0.5px):
 *   - 父节点是 Control 且越界时:父 clip_contents 为 true → clipped_by_parent,否则 → out_of_parent(二者互斥)。
 *   - global_rect 越出视口矩形 [0,0,w,h] → out_of_viewport。
 *   - size 任一边 ≤ 0 且自身 visible → zero_size。
 *   - size 比 min_size 小(超过容差)→ smaller_than_min。
 */
export function computeUiIssues(
  node: InspectedControl,
  viewport: { width: number; height: number },
): UiIssueType[] {
  const issues: UiIssueType[] = [];
  if (node.parent_rect !== null && exceeds(node.global_rect, node.parent_rect)) {
    issues.push(node.parent_clip_contents ? "clipped_by_parent" : "out_of_parent");
  }
  if (exceeds(node.global_rect, [0, 0, viewport.width, viewport.height])) {
    issues.push("out_of_viewport");
  }
  if (node.visible && (node.size[0] <= 0 || node.size[1] <= 0)) {
    issues.push("zero_size");
  }
  if (node.size[0] < node.min_size[0] - UI_ISSUE_TOLERANCE || node.size[1] < node.min_size[1] - UI_ISSUE_TOLERANCE) {
    issues.push("smaller_than_min");
  }
  return issues;
}

/** 各 issue 类型的命中节点数统计(只统计返回出去的节点;truncated 时为部分统计)。 */
export function summarizeUiIssues(nodes: readonly { issues: UiIssueType[] }[]): UiIssueSummary {
  const summary: UiIssueSummary = {
    out_of_parent: 0,
    out_of_viewport: 0,
    zero_size: 0,
    smaller_than_min: 0,
    clipped_by_parent: 0,
  };
  for (const n of nodes) for (const i of n.issues) summary[i] += 1;
  return summary;
}

/**
 * 引擎脚本模板(GDScript,制表符缩进)。
 * 严格只读:不保存场景、不写任何项目文件、不调用 ResourceSaver。
 * 会执行场景内脚本的 _ready/_process —— 这是运行时时探针的固有代价,写进工具描述。
 */
export const INSPECT_UI_SCRIPT = `extends SceneTree

var _scene := ""
var _paths: Array = []
var _frames := 3
var _width := 0
var _height := 0
var _include_hidden := false
var _max_nodes := 300


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var i := 0
	while i < args.size():
		var a: String = args[i]
		if a == "--scene":
			i += 1
			if i < args.size():
				_scene = args[i]
		elif a == "--node":
			i += 1
			if i < args.size():
				_paths.append(args[i])
		elif a == "--frames":
			i += 1
			if i < args.size():
				_frames = int(args[i])
		elif a == "--width":
			i += 1
			if i < args.size():
				_width = int(args[i])
		elif a == "--height":
			i += 1
			if i < args.size():
				_height = int(args[i])
		elif a == "--include-hidden":
			_include_hidden = true
		elif a == "--max-nodes":
			i += 1
			if i < args.size():
				_max_nodes = int(args[i])
		i += 1
	if _scene == "":
		push_error("INSPECT_UI_SCENE_MISSING")
		quit(2)
		return
	var packed: PackedScene = load(_scene)
	if packed == null:
		push_error("INSPECT_UI_SCENE_LOAD_FAILED: " + _scene)
		quit(2)
		return
	var inst: Node = packed.instantiate()
	get_root().add_child(inst)
	_inspect(inst)


func _inspect(inst: Node) -> void:
	await process_frame
	if _width > 0 and _height > 0:
		DisplayServer.window_set_size(Vector2i(_width, _height))
	for _i in _frames:
		await process_frame
	var selected: Array = []
	var missing: Array = []
	if _paths.is_empty():
		_collect(inst, selected)
	else:
		# 显式点名的路径不受 --include-hidden 影响:调用方已经指名,返回比悄悄丢掉更可预期。
		for p in _paths:
			var n: Node = inst.get_node_or_null(NodePath(p))
			if n == null or not (n is Control):
				missing.append(p)
			else:
				selected.append(n)
	var total: int = selected.size()
	var nodes: Array = []
	for c in selected:
		if nodes.size() >= _max_nodes:
			break
		nodes.append(_describe(inst, c))
	var out: Dictionary = {
		"scene": _scene,
		"viewportSize": {"width": get_root().size.x, "height": get_root().size.y},
		"nodeCount": total,
		"truncated": nodes.size() < total,
		"nodes": nodes,
		"missing": missing,
		"engineVersion": Engine.get_version_info()["string"],
	}
	print("MCP_RESULT_JSON=" + JSON.stringify(out))
	quit(0)


func _collect(node: Node, out: Array) -> void:
	if node is Control and (_include_hidden or (node as Control).is_visible_in_tree()):
		out.append(node)
	for child in node.get_children():
		_collect(child, out)


func _rel_path(inst: Node, n: Node) -> String:
	if n == inst:
		return "."
	if not inst.is_ancestor_of(n):
		return ""
	return String(inst.get_path_to(n))


func _describe(inst: Node, n: Node) -> Dictionary:
	var c := n as Control
	var r := c.get_global_rect()
	var parent: Node = c.get_parent()
	var parent_ctl: Control = null
	if parent != null and parent is Control:
		parent_ctl = parent as Control
	var parent_rect = null
	if parent_ctl != null:
		var pr := parent_ctl.get_global_rect()
		parent_rect = [pr.position.x, pr.position.y, pr.size.x, pr.size.y]
	var ms := c.get_combined_minimum_size()
	return {
		"path": _rel_path(inst, c),
		"class": c.get_class(),
		"visible": c.visible,
		"visible_in_tree": c.is_visible_in_tree(),
		"global_rect": [r.position.x, r.position.y, r.size.x, r.size.y],
		"position": [c.position.x, c.position.y],
		"size": [c.size.x, c.size.y],
		"rotation": c.rotation,
		"scale": [c.scale.x, c.scale.y],
		"pivot_offset": [c.pivot_offset.x, c.pivot_offset.y],
		"min_size": [ms.x, ms.y],
		"parent_path": "" if parent_ctl == null else _rel_path(inst, parent_ctl),
		"parent_is_container": parent_ctl != null and parent_ctl is Container,
		"parent_clip_contents": parent_ctl != null and parent_ctl.clip_contents,
		"parent_rect": parent_rect,
	}
`;
