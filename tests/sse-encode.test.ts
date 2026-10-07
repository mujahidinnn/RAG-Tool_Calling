import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SSE_HEADERS, encodeSseEvent } from "@/lib/server/sse";
import type { ChatStreamEvent } from "@/lib/types";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("encodeSseEvent", () => {
  it("format `data: <JSON>` diakhiri 1 baris kosong", () => {
    const event: ChatStreamEvent = { type: "text", delta: "Halo" };
    assert.equal(decode(encodeSseEvent(event)), 'data: {"type":"text","delta":"Halo"}\n\n');
  });

  it("newline di dalam teks tidak memecah event (tetap 1 baris data)", () => {
    const event: ChatStreamEvent = { type: "text", delta: "baris 1\n\ndata: palsu\r\nbaris 3" };
    const wire = decode(encodeSseEvent(event));
    // Hanya 1 pemisah event (di akhir) dan hanya 1 baris yang diawali "data:".
    assert.equal(wire.indexOf("\n\n"), wire.length - 2);
    assert.equal(wire.split("\n").filter((line) => line.startsWith("data:")).length, 1);
    assert.deepEqual(JSON.parse(wire.slice("data: ".length)), event);
  });

  it("karakter non-ASCII di-encode sebagai UTF-8 dan bisa di-decode utuh", () => {
    const event: ChatStreamEvent = {
      type: "error",
      code: "provider_error",
      message: "Anthropic: gagal — coba lagi 🙏",
      retryable: true,
      provider: "anthropic",
    };
    const bytes = encodeSseEvent(event);
    assert.ok(bytes instanceof Uint8Array);
    assert.deepEqual(JSON.parse(decode(bytes).replace(/^data: /, "")), event);
  });

  it("event tanpa field tambahan (done)", () => {
    assert.equal(decode(encodeSseEvent({ type: "done" })), 'data: {"type":"done"}\n\n');
  });
});

describe("SSE_HEADERS", () => {
  it("content-type event-stream + tanpa buffering/transformasi proxy", () => {
    assert.equal(SSE_HEADERS["Content-Type"], "text/event-stream; charset=utf-8");
    assert.match(SSE_HEADERS["Cache-Control"], /no-transform/);
    assert.equal(SSE_HEADERS["X-Accel-Buffering"], "no");
  });
});
