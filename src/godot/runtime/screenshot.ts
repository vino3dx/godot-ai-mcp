// Godot 截图运行器:把截图脚本作为临时文件写入系统临时目录,经 --script 运行。
// 可变参数(场景/输出路径/帧数/缩放)全部经 "--" 之后的用户参数传入,由脚本内
// OS.get_cmdline_user_args() 解析,不把路径拼进脚本文本。
//
// 关键实测结论(真实 Godot 4.6.3,T5 第一步简报):
//   - --script 模式下 autoload 会加载;缺省 scene 读 application/run/main_scene;
//     场景节点 _ready/_process 正常执行(await process_frame 逐帧推进)。
//   - 场景 load 失败用退出码 2 区分;未捕获的运行时错误会让进程挂起,
//     所以脚本对 load 失败显式 quit(2),正常路径 quit(0)。
//   - 截图渲染分辨率 = 工程 viewport 设置,脚本只负责(可选)resize 输出;
//     renderSize(渲染尺寸)经 stdout 一行回传,outputSize 从 PNG 头读取。
//   - --resolution 不影响渲染分辨率(见 run.ts 与 T5 简报),截图必须非 headless。

/** 截图脚本模板(GDScript,制表符缩进)。运行前写入系统临时目录唯一文件,运行后清理。 */
export const SCREENSHOT_SCRIPT = `extends SceneTree

var _out := ""
var _frames := 2
var _out_w := 0
var _out_h := 0

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var scene_path := ""
	var i := 0
	while i < args.size():
		var a: String = args[i]
		if a == "--out":
			i += 1
			if i < args.size():
				_out = args[i]
		elif a == "--scene":
			i += 1
			if i < args.size():
				scene_path = args[i]
		elif a == "--frames":
			i += 1
			if i < args.size():
				_frames = int(args[i])
		elif a == "--width":
			i += 1
			if i < args.size():
				_out_w = int(args[i])
		elif a == "--height":
			i += 1
			if i < args.size():
				_out_h = int(args[i])
		i += 1
	if scene_path == "":
		scene_path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if not scene_path.contains("://"):
		scene_path = "res://" + scene_path
	var scene: PackedScene = load(scene_path)
	if scene == null:
		push_error("SCREENSHOT_SCENE_LOAD_FAILED: " + scene_path)
		quit(2)
		return
	get_root().add_child(scene.instantiate())
	_capture()

func _capture() -> void:
	for _i in _frames:
		await process_frame
	var img: Image = get_root().get_texture().get_image()
	var render_size: Vector2i = img.get_size()
	if _out_w > 0 and _out_h > 0:
		img.resize(_out_w, _out_h, Image.INTERPOLATE_LANCZOS)
	img.save_png(_out)
	print("SCREENSHOT_RENDER_SIZE=" + str(render_size.x) + "x" + str(render_size.y))
	quit(0)
`;

/** 截图参数(纯数据,构建参数用)。 */
export interface ScreenshotMode {
  /** 截图脚本文件的绝对路径(已写入系统临时目录)。 */
  scriptPath: string;
  /** 输出 PNG 的绝对路径。 */
  outPath: string;
  /** 要截图的场景;缺省时脚本读 application/run/main_scene。 */
  scene?: string;
  waitFrames: number;
  outputWidth?: number;
  outputHeight?: number;
}

/** 等待帧数默认值(实测 3 帧足以让静态场景稳定)。 */
export const DEFAULT_WAIT_FRAMES = 3;

/** 构建截图运行参数:--path <project> --script <临时脚本> -- <用户参数>。 */
export function buildScreenshotArgs(projectDir: string, mode: ScreenshotMode): string[] {
  const args = ["--path", projectDir, "--script", mode.scriptPath, "--", "--out", mode.outPath, "--frames", String(mode.waitFrames)];
  if (mode.scene) args.push("--scene", mode.scene);
  if (mode.outputWidth !== undefined) args.push("--width", String(mode.outputWidth));
  if (mode.outputHeight !== undefined) args.push("--height", String(mode.outputHeight));
  return args;
}

const RENDER_SIZE_RE = /SCREENSHOT_RENDER_SIZE=(\d+)x(\d+)/;

/** 从 stdout 解析脚本回传的渲染尺寸;解析失败返回 null。 */
export function parseRenderSize(stdout: string): { width: number; height: number } | null {
  const m = RENDER_SIZE_RE.exec(stdout);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 校验 PNG 签名(前 8 字节)。 */
export function isPng(buf: Buffer): boolean {
  return buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** 从 PNG 头部读取宽高(IHDR:width@16,height@20,big-endian)。 */
export function readPngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
