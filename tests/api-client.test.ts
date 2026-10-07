import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiClientError, listDocuments, streamChat } from "@/lib/client/api";
import type { ChatRequestBody, ChatStreamEvent } from "@/lib/types";

// Test ini mengganti global fetch dengan respons buatan, jadi alur
// "fetch → baca stream → parse SSE → event bertipe" dites tanpa server.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(factory: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => factory()) as typeof fetch;
}

/** Response SSE yang mengirim `chunks` satu per satu (meniru paket jaringan). */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

const BODY: ChatRequestBody = { provider: "anthropic", question: "Apa isinya?", history: [] };

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("streamChat", () => {
  it("menghasilkan event bertipe dari SSE yang terpotong di sembarang tempat", async () => {
    const wire =
      'data: {"type":"text","delta":"Ha"}\n\n' +
      ": keep-alive\n\n" +
      'data: {"type":"text","delta":"lo 👋"}\n\n' +
      'data: {"type":"usage","inputTokens":10,"outputTokens":2,"costUsd":0.0001}\n\n' +
      'data: {"type":"done"}\n\n';
    // Potong per 7 karakter: event & emoji terbelah di batas chunk.
    const chunks = wire.match(/[\s\S]{1,7}/gu) ?? [];
    mockFetch(() => sseResponse(chunks));

    const events = await collect(streamChat(BODY));
    assert.deepEqual(events, [
      { type: "text", delta: "Ha" },
      { type: "text", delta: "lo 👋" },
      { type: "usage", inputTokens: 10, outputTokens: 2, costUsd: 0.0001 },
      { type: "done" },
    ]);
  });

  it("melewati event rusak / tipe tak dikenal tanpa menghentikan stream", async () => {
    mockFetch(() =>
      sseResponse(['data: {"type":"text","delta":"a"}\n\n', "data: {rusak\n\n", 'data: {"type":"baru"}\n\n', 'data: {"type":"done"}\n\n']),
    );
    const events = await collect(streamChat(BODY));
    assert.deepEqual(
      events.map((event) => event.type),
      ["text", "done"],
    );
  });

  it("error JSON sebelum streaming → ApiClientError dengan kode, pesan, & retryAfterSec", async () => {
    mockFetch(() =>
      Response.json(
        { error: { code: "rate_limited", message: "Terlalu banyak pertanyaan.", retryAfterSec: 12, retryable: true } },
        { status: 429, headers: { "Retry-After": "12" } },
      ),
    );
    await assert.rejects(collect(streamChat(BODY)), (err: unknown) => {
      assert.ok(err instanceof ApiClientError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "rate_limited");
      assert.equal(err.message, "Terlalu banyak pertanyaan.");
      assert.equal(err.retryAfterSec, 12);
      return true;
    });
  });

  it("provider tanpa API key → ApiClientError membawa nama provider", async () => {
    mockFetch(() =>
      Response.json(
        { error: { code: "provider_error", message: "OPENAI_API_KEY belum di-set di server.", provider: "openai" } },
        { status: 503 },
      ),
    );
    await assert.rejects(collect(streamChat(BODY)), (err: unknown) => {
      assert.ok(err instanceof ApiClientError);
      assert.equal(err.code, "provider_error");
      assert.equal(err.provider, "openai");
      return true;
    });
  });

  it("respons bukan JSON (mis. halaman error proxy) → pesan fallback yang jelas", async () => {
    mockFetch(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
    await assert.rejects(collect(streamChat(BODY)), (err: unknown) => {
      assert.ok(err instanceof ApiClientError);
      assert.equal(err.code, "internal");
      assert.match(err.message, /Server sedang bermasalah/);
      assert.equal(err.retryable, true);
      return true;
    });
  });

  it("gagal jaringan → kode network; dibatalkan → kode aborted", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(collect(streamChat(BODY)), (err: unknown) => err instanceof ApiClientError && err.code === "network");

    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;
    await assert.rejects(collect(streamChat(BODY)), (err: unknown) => err instanceof ApiClientError && err.code === "aborted");
  });
});

describe("listDocuments", () => {
  it("401 → ApiClientError unauthorized (UI lalu menampilkan gerbang passcode)", async () => {
    mockFetch(() => Response.json({ error: { code: "unauthorized", message: "Masukkan passcode demo dulu." } }, { status: 401 }));
    await assert.rejects(listDocuments(), (err: unknown) => err instanceof ApiClientError && err.code === "unauthorized");
  });
});
