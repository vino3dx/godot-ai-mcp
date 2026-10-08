// 工具输出的大小控制:分页与截断。所有 list 类工具用这个,不要各自实现。

export interface Page<T> { items: T[]; total: number; nextOffset: number | null }

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

/** 切片并给出下一页游标;nextOffset 为 null 表示已到末尾。 */
export function paginate<T>(items: readonly T[], opts: { limit?: number; offset?: number } = {}): Page<T> {
  const total = items.length;
  const offset = Number.isSafeInteger(opts.offset) && (opts.offset as number) > 0 ? (opts.offset as number) : 0;
  const limit = Number.isSafeInteger(opts.limit) && (opts.limit as number) > 0
    ? Math.min(opts.limit as number, MAX_PAGE_LIMIT)
    : DEFAULT_PAGE_LIMIT;
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { items: slice, total, nextOffset: next < total ? next : null };
}

/** 按 UTF-8 字节数截断,不切坏多字节字符。 */
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return { text: out, truncated: true };
}
