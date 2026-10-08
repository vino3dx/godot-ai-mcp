/**
 * 极简行级 unified diff(不新增依赖)。
 * 算法:先吃掉公共前缀/公共后缀,中间整段作为"删除块 + 新增块"输出,带 context 行。
 * 对"改一个键"这类单点修改,前缀/后缀裁剪后正好只剩改动行 —— 输出与 git 一致。
 * 不做多 hunk 拆分(多处分散改动会合并成一个大 hunk),保持实现简单可靠。
 */
export interface DiffOptions { context?: number; aLabel?: string; bLabel?: string }

const NO_NEWLINE = "\\ No newline at end of file";

interface Lines { lines: string[]; endsWithNewline: boolean }

/** 按 `\n` 切行:空文件 → 0 行;`"a\n"` → ["a"] + 末尾有换行。 */
function split(text: string): Lines {
  if (text === "") return { lines: [], endsWithNewline: false };
  const parts = text.split("\n");
  const endsWithNewline = parts.length > 1 && parts[parts.length - 1] === "";
  if (endsWithNewline) parts.pop();
  return { lines: parts, endsWithNewline };
}

/** 无差异返回空串。行号 1 基;区间长度为 0 时按 git 惯例写"插入点前的行数"。 */
export function unifiedDiff(oldText: string, newText: string, opts: DiffOptions = {}): string {
  const ctx = Math.max(0, opts.context ?? 3);
  const a = split(oldText);
  const b = split(newText);
  const AL = a.lines;
  const BL = b.lines;

  let p = 0;
  while (p < AL.length && p < BL.length && AL[p] === BL[p]) p++;
  let s = 0;
  while (s < AL.length - p && s < BL.length - p && AL[AL.length - 1 - s] === BL[BL.length - 1 - s]) s++;

  if (p === AL.length && p === BL.length) {
    // 行内容完全相同:只有"文件末尾换行"不同时才算有差异
    if (a.endsWithNewline === b.endsWithNewline) return "";
    p = Math.max(0, p - 1);
    s = 0;
  }

  const head = Math.max(0, p - ctx);
  const tail = Math.min(ctx, s);
  const aFrom = head;
  const aTo = AL.length - s + tail;
  const bFrom = head;
  const bTo = BL.length - s + tail;

  const out: string[] = [
    `--- ${opts.aLabel ?? "a"}`,
    `+++ ${opts.bLabel ?? "b"}`,
    `@@ -${rangeHead(aFrom, aTo - aFrom)},${aTo - aFrom} +${rangeHead(bFrom, bTo - bFrom)},${bTo - bFrom} @@`,
  ];
  for (let i = aFrom; i < p; i++) out.push(" " + AL[i]!);
  if (AL.length - s > p) {
    for (let i = p; i < AL.length - s; i++) out.push("-" + AL[i]!);
    if (s === 0 && !a.endsWithNewline) out.push(NO_NEWLINE);
  }
  if (BL.length - s > p) {
    for (let i = p; i < BL.length - s; i++) out.push("+" + BL[i]!);
    if (s === 0 && !b.endsWithNewline) out.push(NO_NEWLINE);
  }
  for (let i = AL.length - s; i < aTo; i++) out.push(" " + AL[i]!);
  return out.join("\n") + "\n";
}

function rangeHead(from: number, count: number): number {
  return count === 0 ? from : from + 1;
}
