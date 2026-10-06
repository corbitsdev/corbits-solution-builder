/**
 * Follows a file as it grows, handing on each new stretch of text.
 *
 * Polled rather than watched: a file another process appends to is exactly
 * what file watching gets wrong on macOS. Multi-byte characters split
 * across two reads are joined, so a chunk never ends mid-character. `stop`
 * reads whatever landed last, then resolves.
 */
import { open, stat } from "node:fs/promises";

export type FileFollower = { readonly stop: () => Promise<void> };

export function followFile(
  path: string,
  onText: (text: string) => void,
  options: { readonly intervalMs?: number; readonly from?: "start" | "end" } = {},
): FileFollower {
  const intervalMs = options.intervalMs ?? 500;
  let offset: number | null = options.from === "end" ? null : 0;
  const decoder = new TextDecoder();
  let reading: Promise<void> = Promise.resolve();

  const readNew = async () => {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    // Following from the end: what is there now was written before this
    // follower, and is not said again.
    if (offset === null) {
      offset = size;
      return;
    }
    if (size <= offset) return;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      if (text.length > 0) onText(text);
    } finally {
      await handle.close();
    }
  };

  const tick = () => {
    reading = reading.then(readNew).catch(() => undefined);
  };
  const timer = setInterval(tick, intervalMs);

  return {
    stop: async () => {
      clearInterval(timer);
      tick();
      await reading;
      const rest = decoder.decode();
      if (rest.length > 0) onText(rest);
    },
  };
}
