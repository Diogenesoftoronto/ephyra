import type { IdGen } from "./ports.ts";

/** RFC 9562 UUIDv7: 48-bit unix ms timestamp, then random bits. Monotonic within a process. */
let lastMs = 0;
let seq = 0;
export function uuidv7(nowMs: number = Date.now()): string {
  if (nowMs <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs += 1;
    nowMs = lastMs;
  } else {
    seq = crypto.getRandomValues(new Uint16Array(1))[0]! & 0x7ff;
    lastMs = nowMs;
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const ms = BigInt(nowMs);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Display id "T-xxxxxx": the last six hex digits of the random tail. */
export function shortId(id: string): string {
  return `T-${id.replace(/-/g, "").slice(-6)}`;
}

export const systemIds: IdGen = { uuidv7: () => uuidv7() };
