export type LogStream = "stdout" | "stderr";
export interface LogReadResult { text: string; nextOffset: number; oldestOffset: number; latestOffset: number; droppedBytes: number; truncated: boolean }

interface StreamState { chunks: Buffer[]; bytes: number; oldestOffset: number; latestOffset: number; droppedBytes: number }

/** Per-stream UTF-8 byte-offset ring buffer. Offsets advance for all received bytes, including discarded bytes. */
export class BoundedLogBuffer {
  private readonly state: Record<LogStream, StreamState> = {
    stdout: { chunks: [], bytes: 0, oldestOffset: 0, latestOffset: 0, droppedBytes: 0 },
    stderr: { chunks: [], bytes: 0, oldestOffset: 0, latestOffset: 0, droppedBytes: 0 },
  };

  constructor(readonly maxBytesPerStream = 256 * 1024) {
    if (!Number.isSafeInteger(maxBytesPerStream) || maxBytesPerStream < 0) throw new RangeError("maxBytesPerStream must be a non-negative safe integer");
  }

  append(stream: LogStream, input: Buffer | string): void {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
    if (chunk.length === 0) return;
    const s = this.state[stream];
    s.latestOffset += chunk.length;
    if (this.maxBytesPerStream === 0) { s.droppedBytes += chunk.length; s.oldestOffset = s.latestOffset; return; }
    s.chunks.push(Buffer.from(chunk)); s.bytes += chunk.length;
    if (s.bytes > this.maxBytesPerStream) {
      let retained = Buffer.concat(s.chunks);
      let cut = s.bytes - this.maxBytesPerStream;
      // Discard continuation bytes so the new oldest offset always starts at a UTF-8 code point.
      while (cut < retained.length && (retained[cut]! & 0xc0) === 0x80) cut++;
      retained = retained.subarray(cut);
      s.droppedBytes += cut; s.oldestOffset += cut; s.bytes = retained.length;
      s.chunks = retained.length === 0 ? [] : [retained];
    }
  }

  read(stream: LogStream, offset = 0, maxBytes = this.maxBytesPerStream): LogReadResult {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative safe integer");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
    const s = this.state[stream];
    const start = Math.max(offset, s.oldestOffset);
    const available = Math.min(maxBytes, Math.max(0, s.latestOffset - start));
    const decoder = new TextDecoder("utf-8");
    let skip = start - s.oldestOffset;
    let remaining = available;
    let text = "";
    for (const chunk of s.chunks) {
      if (skip >= chunk.length) { skip -= chunk.length; continue; }
      const slice = chunk.subarray(skip, skip + remaining);
      text += decoder.decode(slice, { stream: true });
      remaining -= slice.length; skip = 0;
      if (remaining <= 0) break;
    }
    text += decoder.decode();
    const consumedBytes = available - remaining;
    return {
      text,
      nextOffset: start + consumedBytes,
      oldestOffset: s.oldestOffset,
      latestOffset: s.latestOffset,
      droppedBytes: Math.max(0, s.oldestOffset - offset),
      truncated: offset < s.oldestOffset,
    };
  }
}
