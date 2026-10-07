import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RawMessageStreamEvent, StopReason } from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

import {
  collectStream,
  mapAnthropicStream,
  mapOpenAIStream,
  parseToolArguments,
} from "@/lib/llm/stream";
import { ProviderError, type StreamEvent } from "@/lib/llm/types";

// Test ini memberi urutan event PALSU (bentuknya mengikuti event asli dari
// API) ke fungsi pemetaan stream — tanpa jaringan, tanpa API key.

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function collectEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Kumpulkan event sampai error, lalu kembalikan keduanya (untuk cek teks sebelum error). */
async function collectUntilError(
  stream: AsyncIterable<StreamEvent>,
): Promise<{ events: StreamEvent[]; error: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
  } catch (error) {
    return { events, error };
  }
  return { events, error: null };
}

function assertProviderError(
  error: unknown,
  expected: { provider: "anthropic" | "openai"; code: string; message?: RegExp },
): void {
  assert.ok(error instanceof ProviderError, `bukan ProviderError: ${String(error)}`);
  assert.equal(error.provider, expected.provider);
  assert.equal(error.code, expected.code);
  if (expected.message) assert.match(error.message, expected.message);
}

// ---------------------------------------------------------------------------
// Builder event Anthropic (Messages API streaming)
// ---------------------------------------------------------------------------

const ant = {
  messageStart(
    inputTokens: number,
    cache: { read?: number; write?: number } = {},
  ): RawMessageStreamEvent {
    return {
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        container: null,
        diagnostics: null,
        stop_details: null,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 1,
          cache_read_input_tokens: cache.read ?? 0,
          cache_creation_input_tokens: cache.write ?? 0,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: "standard",
        },
      },
    };
  },
  textStart(index: number): RawMessageStreamEvent {
    return { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } };
  },
  thinkingStart(index: number): RawMessageStreamEvent {
    return {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    };
  },
  toolStart(index: number, id: string, name: string): RawMessageStreamEvent {
    return {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {}, caller: { type: "direct" } },
    };
  },
  text(index: number, text: string): RawMessageStreamEvent {
    return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
  },
  thinking(index: number, thinking: string): RawMessageStreamEvent {
    return { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } };
  },
  signature(index: number): RawMessageStreamEvent {
    return { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig==" } };
  },
  json(index: number, partial_json: string): RawMessageStreamEvent {
    return { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } };
  },
  stop(index: number): RawMessageStreamEvent {
    return { type: "content_block_stop", index };
  },
  messageDelta(
    stopReason: StopReason,
    outputTokens: number,
    refusalCategory: "cyber" | null = null,
  ): RawMessageStreamEvent {
    return {
      type: "message_delta",
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
        container: null,
        stop_details:
          stopReason === "refusal"
            ? { type: "refusal", category: refusalCategory, explanation: null }
            : null,
      },
      usage: {
        output_tokens: outputTokens,
        input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        output_tokens_details: null,
        server_tool_use: null,
      },
    };
  },
  messageStop(): RawMessageStreamEvent {
    return { type: "message_stop" };
  },
};

describe("mapAnthropicStream", () => {
  it("teks saja: delta diteruskan apa adanya, lalu done dengan usage", async () => {
    const events = await collectEvents(
      mapAnthropicStream(
        fromArray([
          ant.messageStart(1200),
          ant.textStart(0),
          ant.text(0, "Halo"),
          ant.text(0, ", dunia"),
          ant.stop(0),
          ant.messageDelta("end_turn", 42),
          ant.messageStop(),
        ]),
      ),
    );
    assert.deepEqual(events, [
      { type: "text", delta: "Halo" },
      { type: "text", delta: ", dunia" },
      { type: "done", inputTokens: 1200, outputTokens: 42 },
    ]);
  });

  it("thinking diabaikan; teks lalu tool call → teks di-stream, tool_call setelahnya, lalu done", async () => {
    const events = await collectEvents(
      mapAnthropicStream(
        fromArray([
          ant.messageStart(900),
          ant.thinkingStart(0),
          ant.thinking(0, ""),
          ant.signature(0),
          ant.stop(0),
          ant.textStart(1),
          ant.text(1, "Saya ringkas dokumennya dulu."),
          ant.stop(1),
          ant.toolStart(2, "toolu_01ABC", "get_document_summary"),
          ant.json(2, ""),
          ant.json(2, '{"document_'),
          ant.json(2, 'id": "3f6c'),
          ant.json(2, '-uuid"}'),
          ant.stop(2),
          ant.messageDelta("tool_use", 77),
          ant.messageStop(),
        ]),
      ),
    );
    assert.deepEqual(events, [
      { type: "text", delta: "Saya ringkas dokumennya dulu." },
      {
        type: "tool_call",
        id: "toolu_01ABC",
        name: "get_document_summary",
        input: { document_id: "3f6c-uuid" },
      },
      { type: "done", inputTokens: 900, outputTokens: 77 },
    ]);
  });

  it("parallel tool calls: semua dikirim berurutan sesuai blok; input kosong → {}", async () => {
    const events = await collectEvents(
      mapAnthropicStream(
        fromArray([
          ant.messageStart(500),
          ant.toolStart(0, "toolu_list", "list_uploaded_documents"),
          ant.stop(0),
          ant.toolStart(1, "toolu_sum", "get_document_summary"),
          ant.json(1, '{"document_id":"abc"}'),
          ant.stop(1),
          ant.messageDelta("tool_use", 60),
          ant.messageStop(),
        ]),
      ),
    );
    assert.deepEqual(events, [
      { type: "tool_call", id: "toolu_list", name: "list_uploaded_documents", input: {} },
      { type: "tool_call", id: "toolu_sum", name: "get_document_summary", input: { document_id: "abc" } },
      { type: "done", inputTokens: 500, outputTokens: 60 },
    ]);
  });

  it("usage: input = input + cache read + cache write; output dari message_delta (kumulatif)", async () => {
    const events = await collectEvents(
      mapAnthropicStream(
        fromArray([
          ant.messageStart(100, { read: 50, write: 25 }),
          ant.textStart(0),
          ant.text(0, "ok"),
          ant.stop(0),
          ant.messageDelta("end_turn", 10),
          ant.messageDelta("end_turn", 12), // delta kedua menimpa, bukan menambah
          ant.messageStop(),
        ]),
      ),
    );
    assert.deepEqual(events.at(-1), { type: "done", inputTokens: 175, outputTokens: 12 });
  });

  it("message_delta dari wire tanpa field input_tokens (bentuk payload lama) → token input tetap dari message_start", async () => {
    // Persis seperti SDK: payload SSE di-JSON.parse lalu dianggap bertipe event.
    // Tipe SDK menyebut input_tokens wajib, tapi di wire bisa tidak dikirim.
    const legacyDelta = JSON.parse(
      '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":88}}',
    ) as RawMessageStreamEvent;
    const events = await collectEvents(
      mapAnthropicStream(
        fromArray([ant.messageStart(1500), ant.textStart(0), ant.text(0, "ok"), ant.stop(0), legacyDelta, ant.messageStop()]),
      ),
    );
    assert.deepEqual(events.at(-1), { type: "done", inputTokens: 1500, outputTokens: 88 });
  });

  it("refusal → teks yang sudah keluar tetap diteruskan, lalu ProviderError refusal (tanpa done)", async () => {
    const { events, error } = await collectUntilError(
      mapAnthropicStream(
        fromArray([
          ant.messageStart(300),
          ant.textStart(0),
          ant.text(0, "Berikut cara"),
          ant.stop(0),
          ant.messageDelta("refusal", 5, "cyber"),
          ant.messageStop(),
        ]),
      ),
    );
    assert.deepEqual(events, [{ type: "text", delta: "Berikut cara" }]);
    assertProviderError(error, { provider: "anthropic", code: "refusal", message: /kategori: cyber/ });
  });

  it("refusal memotong tool_use → tool TIDAK dikirim", async () => {
    const { events, error } = await collectUntilError(
      mapAnthropicStream(
        fromArray([
          ant.messageStart(300),
          ant.toolStart(0, "toolu_x", "get_document_summary"),
          ant.json(0, '{"document_id": "ab'),
          ant.stop(0),
          ant.messageDelta("refusal", 5),
          ant.messageStop(),
        ]),
      ),
    );
    assert.equal(events.length, 0);
    assertProviderError(error, { provider: "anthropic", code: "refusal" });
  });

  it("max_tokens saat ada tool_use → error, tool setengah jadi tidak dieksekusi", async () => {
    const { events, error } = await collectUntilError(
      mapAnthropicStream(
        fromArray([
          ant.messageStart(300),
          ant.toolStart(0, "toolu_x", "get_document_summary"),
          ant.json(0, '{"document_id": "ab'),
          ant.stop(0),
          ant.messageDelta("max_tokens", 4096),
          ant.messageStop(),
        ]),
      ),
    );
    assert.equal(events.filter((e) => e.type === "tool_call").length, 0);
    assertProviderError(error, { provider: "anthropic", code: "unknown", message: /terpotong/ });
  });

  it("max_tokens pada jawaban teks biasa → tetap selesai normal (teks terpotong)", async () => {
    const events = await collectEvents(
      mapAnthropicStream(
        fromArray([
          ant.messageStart(300),
          ant.textStart(0),
          ant.text(0, "Jawaban panjang yang terpo"),
          ant.stop(0),
          ant.messageDelta("max_tokens", 4096),
          ant.messageStop(),
        ]),
      ),
    );
    assert.deepEqual(events.at(-1), { type: "done", inputTokens: 300, outputTokens: 4096 });
  });

  it("JSON input tool rusak → input berupa penanda INVALID_JSON (tool akan menolaknya)", async () => {
    const events = await collectEvents(
      mapAnthropicStream(
        fromArray([
          ant.messageStart(10),
          ant.toolStart(0, "toolu_bad", "get_document_summary"),
          ant.json(0, '{"document_id": "a"b"}'),
          ant.stop(0),
          ant.messageDelta("tool_use", 9),
          ant.messageStop(),
        ]),
      ),
    );
    assert.deepEqual(events[0], {
      type: "tool_call",
      id: "toolu_bad",
      name: "get_document_summary",
      input: { INVALID_JSON: '{"document_id": "a"b"}' },
    });
  });

  it("stream berhenti tanpa message_stop → ProviderError network (bukan sukses diam-diam)", async () => {
    const { events, error } = await collectUntilError(
      mapAnthropicStream(fromArray([ant.messageStart(10), ant.textStart(0), ant.text(0, "Sebagian")])),
    );
    assert.deepEqual(events, [{ type: "text", delta: "Sebagian" }]);
    assertProviderError(error, { provider: "anthropic", code: "network" });
  });
});

// ---------------------------------------------------------------------------
// Builder chunk OpenAI (Chat Completions streaming)
// ---------------------------------------------------------------------------

type Delta = ChatCompletionChunk.Choice.Delta;
type FinishReason = ChatCompletionChunk.Choice["finish_reason"];

const oai = {
  chunk(delta: Delta, finishReason: FinishReason = null): ChatCompletionChunk {
    return {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1_790_000_000,
      model: "gpt-5.6-terra",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: null,
    };
  },
  finish(finishReason: Exclude<FinishReason, null>): ChatCompletionChunk {
    return oai.chunk({}, finishReason);
  },
  usage(promptTokens: number, completionTokens: number): ChatCompletionChunk {
    return {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1_790_000_000,
      model: "gpt-5.6-terra",
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  },
  toolStart(index: number, id: string, name: string): ChatCompletionChunk {
    return oai.chunk({
      tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
    });
  },
  toolArgs(index: number, args: string): ChatCompletionChunk {
    return oai.chunk({ tool_calls: [{ index, function: { arguments: args } }] });
  },
};

describe("mapOpenAIStream", () => {
  it("teks saja: chunk role kosong dilewati, delta diteruskan, usage dari chunk terakhir", async () => {
    const events = await collectEvents(
      mapOpenAIStream(
        fromArray([
          oai.chunk({ role: "assistant", content: "" }),
          oai.chunk({ content: "Halo" }),
          oai.chunk({ content: ", dunia" }),
          oai.finish("stop"),
          oai.usage(1300, 25),
        ]),
      ),
    );
    assert.deepEqual(events, [
      { type: "text", delta: "Halo" },
      { type: "text", delta: ", dunia" },
      { type: "done", inputTokens: 1300, outputTokens: 25 },
    ]);
  });

  it("teks lalu tool call: argumen disambung dari potongan, id/nama dari potongan pertama", async () => {
    const events = await collectEvents(
      mapOpenAIStream(
        fromArray([
          oai.chunk({ role: "assistant", content: "Saya cek dulu." }),
          oai.toolStart(0, "call_abc", "get_document_summary"),
          oai.toolArgs(0, '{"document_'),
          oai.toolArgs(0, 'id":"3f6c-uuid"}'),
          oai.finish("tool_calls"),
          oai.usage(800, 40),
        ]),
      ),
    );
    assert.deepEqual(events, [
      { type: "text", delta: "Saya cek dulu." },
      {
        type: "tool_call",
        id: "call_abc",
        name: "get_document_summary",
        input: { document_id: "3f6c-uuid" },
      },
      { type: "done", inputTokens: 800, outputTokens: 40 },
    ]);
  });

  it("parallel tool calls yang potongannya selang-seling (termasuk 2 dalam 1 chunk)", async () => {
    const events = await collectEvents(
      mapOpenAIStream(
        fromArray([
          oai.toolStart(0, "call_list", "list_uploaded_documents"),
          oai.chunk({
            tool_calls: [
              { index: 1, id: "call_sum", type: "function", function: { name: "get_document_summary", arguments: '{"doc' } },
              { index: 0, function: { arguments: "{}" } },
            ],
          }),
          oai.toolArgs(1, 'ument_id":"abc"}'),
          oai.finish("tool_calls"),
          oai.usage(700, 55),
        ]),
      ),
    );
    assert.deepEqual(events, [
      { type: "tool_call", id: "call_list", name: "list_uploaded_documents", input: {} },
      { type: "tool_call", id: "call_sum", name: "get_document_summary", input: { document_id: "abc" } },
      { type: "done", inputTokens: 700, outputTokens: 55 },
    ]);
  });

  it("usage tidak datang (stream terganggu setelah finish) → done tetap dikirim dengan 0", async () => {
    const events = await collectEvents(
      mapOpenAIStream(fromArray([oai.chunk({ content: "ok" }), oai.finish("stop")])),
    );
    assert.deepEqual(events.at(-1), { type: "done", inputTokens: 0, outputTokens: 0 });
  });

  it("refusal → teksnya TIDAK di-stream sebagai jawaban, jadi ProviderError refusal", async () => {
    const { events, error } = await collectUntilError(
      mapOpenAIStream(
        fromArray([
          oai.chunk({ role: "assistant", refusal: "" }),
          oai.chunk({ refusal: "Maaf, saya tidak bisa " }),
          oai.chunk({ refusal: "membantu itu." }),
          oai.finish("stop"),
          oai.usage(100, 8),
        ]),
      ),
    );
    assert.equal(events.length, 0);
    assertProviderError(error, {
      provider: "openai",
      code: "refusal",
      message: /Maaf, saya tidak bisa membantu itu\./,
    });
  });

  it("finish_reason content_filter → ProviderError refusal", async () => {
    const { error } = await collectUntilError(
      mapOpenAIStream(
        fromArray([oai.chunk({ content: "Ber" }), oai.finish("content_filter"), oai.usage(100, 3)]),
      ),
    );
    assertProviderError(error, { provider: "openai", code: "refusal", message: /filter konten/ });
  });

  it("finish_reason length saat ada tool call → error, tool tidak dikirim", async () => {
    const { events, error } = await collectUntilError(
      mapOpenAIStream(
        fromArray([
          oai.toolStart(0, "call_x", "get_document_summary"),
          oai.toolArgs(0, '{"document_id":"a'),
          oai.finish("length"),
          oai.usage(100, 4096),
        ]),
      ),
    );
    assert.equal(events.length, 0);
    assertProviderError(error, { provider: "openai", code: "unknown", message: /terpotong/ });
  });

  it("argumen JSON rusak → penanda INVALID_JSON", async () => {
    const events = await collectEvents(
      mapOpenAIStream(
        fromArray([
          oai.toolStart(0, "call_bad", "get_document_summary"),
          oai.toolArgs(0, "{document_id: abc}"),
          oai.finish("tool_calls"),
          oai.usage(10, 5),
        ]),
      ),
    );
    assert.deepEqual(events[0], {
      type: "tool_call",
      id: "call_bad",
      name: "get_document_summary",
      input: { INVALID_JSON: "{document_id: abc}" },
    });
  });

  it("stream berhenti tanpa finish_reason → ProviderError network", async () => {
    const { events, error } = await collectUntilError(
      mapOpenAIStream(fromArray([oai.chunk({ content: "Sebagian" })])),
    );
    assert.deepEqual(events, [{ type: "text", delta: "Sebagian" }]);
    assertProviderError(error, { provider: "openai", code: "network" });
  });
});

describe("parseToolArguments", () => {
  it("string kosong → {} (tool tanpa parameter)", () => {
    assert.deepEqual(parseToolArguments(""), {});
    assert.deepEqual(parseToolArguments("  "), {});
  });

  it("objek JSON valid → objeknya", () => {
    assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  });

  it("JSON valid tapi bukan objek / JSON rusak → penanda INVALID_JSON", () => {
    assert.deepEqual(parseToolArguments("[1,2]"), { INVALID_JSON: "[1,2]" });
    assert.deepEqual(parseToolArguments('"teks"'), { INVALID_JSON: '"teks"' });
    assert.deepEqual(parseToolArguments('{"a":'), { INVALID_JSON: '{"a":' });
  });
});

describe("collectStream", () => {
  it("menggabungkan teks, mengumpulkan tool call, dan menjumlah token", async () => {
    const result = await collectStream(
      fromArray<StreamEvent>([
        { type: "text", delta: "Halo " },
        { type: "text", delta: "dunia" },
        { type: "tool_call", id: "t1", name: "list_uploaded_documents", input: {} },
        { type: "done", inputTokens: 100, outputTokens: 20 },
      ]),
    );
    assert.deepEqual(result, {
      text: "Halo dunia",
      toolCalls: [{ id: "t1", name: "list_uploaded_documents", input: {} }],
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it("error dari provider diteruskan apa adanya", async () => {
    async function* failing(): AsyncGenerator<StreamEvent> {
      yield { type: "text", delta: "x" };
      throw new ProviderError({ provider: "openai", code: "rate_limit", message: "OpenAI: limit" });
    }
    await assert.rejects(collectStream(failing()), (error: unknown) => {
      assertProviderError(error, { provider: "openai", code: "rate_limit" });
      return true;
    });
  });
});
