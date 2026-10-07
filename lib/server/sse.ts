// Encoder Server-Sent Events untuk POST /api/chat. PURE (diuji di
// tests/sse-encode.test.ts): tanpa server-only / next / env.
//
// Format wire (lihat ChatStreamEvent di lib/types.ts):
//   data: {"type":"text","delta":"Halo"}\n\n
// Satu event = satu baris `data:` + baris kosong. JSON.stringify tidak pernah
// menghasilkan newline mentah (newline di dalam string jadi "\n"), jadi isi
// teks apa pun dari LLM tidak bisa "memecah" event atau memalsukan event baru.

import type { ChatStreamEvent } from "@/lib/types";

const encoder = new TextEncoder();

/** Satu event chat → byte SSE siap di-enqueue ke ReadableStream. */
export function encodeSseEvent(event: ChatStreamEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Header respons streaming:
 * - `no-transform`: proxy/CDN tidak boleh mengompres/mengubah body (kompresi
 *   membuat proxy menahan data sampai buffer penuh → token tidak mengalir).
 * - `X-Accel-Buffering: no`: mematikan buffering respons di nginx (umum di
 *   self-hosting), alasan yang sama.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};
