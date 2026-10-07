import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAIMessages,
  toOpenAITools,
} from "@/lib/llm/translate";
import type { AssistantReplay, Message, Tool } from "@/lib/llm/types";

const listTool: Tool = {
  name: "list_uploaded_documents",
  description: "Daftar dokumen",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

const summaryTool: Tool = {
  name: "get_document_summary",
  description: "Ringkas dokumen",
  input_schema: {
    type: "object",
    properties: { document_id: { type: "string" } },
    required: ["document_id"],
    additionalProperties: false,
  },
};

function toolMessage(id: string, name: string, input: unknown, content: string): Message {
  return { role: "tool", toolCallId: id, toolName: name, input, content };
}

describe("toAnthropicMessages", () => {
  it("riwayat teks saja → string content, role tetap", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "Halo" },
      { role: "assistant", content: "Hai, ada yang bisa dibantu?" },
      { role: "user", content: "Apa isi dokumen?" },
    ]);
    assert.deepEqual(result, [
      { role: "user", content: "Halo" },
      { role: "assistant", content: "Hai, ada yang bisa dibantu?" },
      { role: "user", content: "Apa isi dokumen?" },
    ]);
  });

  it("1 tool call → tool_use di assistant baru + tool_result di user berikutnya", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "Dokumen apa saja?" },
      toolMessage("toolu_1", "list_uploaded_documents", {}, '[{"filename":"a.pdf"}]'),
    ]);
    assert.deepEqual(result, [
      { role: "user", content: "Dokumen apa saja?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "list_uploaded_documents", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '[{"filename":"a.pdf"}]' }],
      },
    ]);
  });

  it("parallel tool calls berbagi SATU giliran assistant dan SATU giliran user", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "Ringkas semua dokumen" },
      toolMessage("toolu_a", "get_document_summary", { document_id: "A" }, "ringkasan A"),
      toolMessage("toolu_b", "get_document_summary", { document_id: "B" }, "ringkasan B"),
    ]);
    assert.equal(result.length, 3);
    assert.deepEqual(result[1], {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_a", name: "get_document_summary", input: { document_id: "A" } },
        { type: "tool_use", id: "toolu_b", name: "get_document_summary", input: { document_id: "B" } },
      ],
    });
    assert.deepEqual(result[2], {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "ringkasan A" },
        { type: "tool_result", tool_use_id: "toolu_b", content: "ringkasan B" },
      ],
    });
  });

  it("teks assistant lalu tool call → digabung dalam satu giliran assistant (teks dulu)", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "Ringkas dokumen A" },
      { role: "assistant", content: "Saya cek dulu daftar dokumennya." },
      toolMessage("toolu_1", "list_uploaded_documents", {}, "[]"),
    ]);
    assert.deepEqual(result[1], {
      role: "assistant",
      content: [
        { type: "text", text: "Saya cek dulu daftar dokumennya." },
        { type: "tool_use", id: "toolu_1", name: "list_uploaded_documents", input: {} },
      ],
    });
    assert.equal(result[2].role, "user");
  });

  it("2 ronde tool dipisah teks assistant → 2 pasang giliran terpisah, role bergantian", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "Ringkas dokumen panduan" },
      toolMessage("toolu_1", "list_uploaded_documents", {}, '[{"id":"A"}]'),
      { role: "assistant", content: "Dokumennya ketemu, saya ringkas." },
      toolMessage("toolu_2", "get_document_summary", { document_id: "A" }, "ringkasan"),
    ]);
    assert.deepEqual(
      result.map((m) => m.role),
      ["user", "assistant", "user", "assistant", "user"],
    );
    const lastAssistant = result[3];
    assert.ok(Array.isArray(lastAssistant.content));
    assert.deepEqual(
      lastAssistant.content.map((block) => block.type),
      ["text", "tool_use"],
    );
  });

  it("membuang teks kosong dan giliran assistant di awal riwayat", () => {
    const result = toAnthropicMessages([
      { role: "assistant", content: "Sisa jawaban lama (riwayat terpotong)" },
      { role: "user", content: "Pertanyaan" },
      { role: "assistant", content: "   " },
      { role: "user", content: "Pertanyaan lanjutan" },
    ]);
    // Dua pesan user berurutan digabung jadi satu giliran user.
    assert.deepEqual(result, [
      {
        role: "user",
        content: [
          { type: "text", text: "Pertanyaan" },
          { type: "text", text: "Pertanyaan lanjutan" },
        ],
      },
    ]);
  });

  it("input tool yang bukan objek diganti {} (Anthropic wajib objek)", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "x" },
      toolMessage("toolu_1", "list_uploaded_documents", null, "[]"),
    ]);
    const assistant = result[1];
    assert.ok(Array.isArray(assistant.content));
    const [block] = assistant.content;
    assert.equal(block.type, "tool_use");
    if (block.type === "tool_use") assert.deepEqual(block.input, {});
  });
});

describe("toAnthropicMessages — loop tool dengan blok thinking & error", () => {
  const replayRound = (id: string, signature: string): AssistantReplay => ({
    provider: "anthropic",
    blocks: [
      { type: "thinking", thinking: "", signature },
      { type: "text", text: "Saya cek dulu." },
      { type: "tool_use", id, name: "list_uploaded_documents", input: {} },
    ],
  });

  it("assistant dengan replay → giliran asli dikirim apa adanya; pesan tool hanya menambah tool_result", () => {
    const replay = replayRound("toolu_1", "sig-1");
    const result = toAnthropicMessages([
      { role: "user", content: "Dokumen apa saja?" },
      { role: "assistant", content: "Saya cek dulu.", replay },
      toolMessage("toolu_1", "list_uploaded_documents", {}, '{"total":1}'),
    ]);
    assert.deepEqual(result, [
      { role: "user", content: "Dokumen apa saja?" },
      { role: "assistant", content: replay.blocks },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"total":1}' }] },
    ]);
  });

  it("2 ronde replay berturut-turut TIDAK digabung jadi 1 giliran (blok thinking tetap di gilirannya)", () => {
    const first = replayRound("toolu_1", "sig-1");
    const second = replayRound("toolu_2", "sig-2");
    const result = toAnthropicMessages([
      { role: "user", content: "Tanya" },
      { role: "assistant", content: "", replay: first },
      toolMessage("toolu_1", "list_uploaded_documents", {}, "a"),
      { role: "assistant", content: "", replay: second },
      toolMessage("toolu_2", "list_uploaded_documents", {}, "b"),
    ]);
    assert.deepEqual(
      result.map((turn) => turn.role),
      ["user", "assistant", "user", "assistant", "user"],
    );
    assert.deepEqual(result[1].content, first.blocks);
    assert.deepEqual(result[3].content, second.blocks);
  });

  it("ronde tool tanpa thinking setelah giliran replay → giliran baru, giliran replay tidak diubah", () => {
    const first = replayRound("toolu_1", "sig-1");
    const result = toAnthropicMessages([
      { role: "user", content: "Tanya" },
      { role: "assistant", content: "", replay: first },
      toolMessage("toolu_1", "list_uploaded_documents", {}, "a"),
      toolMessage("toolu_2", "get_document_summary", { document_id: "x" }, "b"),
    ]);
    assert.deepEqual(
      result.map((turn) => turn.role),
      ["user", "assistant", "user", "assistant", "user"],
    );
    assert.deepEqual(result[1].content, first.blocks);
    assert.deepEqual(result[3].content, [
      { type: "tool_use", id: "toolu_2", name: "get_document_summary", input: { document_id: "x" } },
    ]);
  });

  it("tool gagal (isError) → tool_result dengan is_error: true", () => {
    const result = toAnthropicMessages([
      { role: "user", content: "Ringkas" },
      { ...toolMessage("toolu_x", "get_document_summary", { document_id: "a" }, '{"error":"masih diproses"}'), isError: true } as Message,
    ]);
    assert.deepEqual(result[2], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_x", content: '{"error":"masih diproses"}', is_error: true }],
    });
  });

  it("OpenAI mengabaikan replay & isError (tidak punya padanannya)", () => {
    const result = toOpenAIMessages("", [
      { role: "user", content: "Tanya" },
      { role: "assistant", content: "Saya cek dulu.", replay: replayRound("call_1", "sig") },
      { ...toolMessage("call_1", "list_uploaded_documents", {}, "x"), isError: true } as Message,
    ]);
    assert.deepEqual(result, [
      { role: "user", content: "Tanya" },
      {
        role: "assistant",
        content: "Saya cek dulu.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "list_uploaded_documents", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "x" },
    ]);
  });
});

describe("toAnthropicTools", () => {
  it("meneruskan input_schema apa adanya + eager_input_streaming", () => {
    assert.deepEqual(toAnthropicTools([summaryTool]), [
      {
        name: "get_document_summary",
        description: "Ringkas dokumen",
        input_schema: summaryTool.input_schema,
        eager_input_streaming: true,
      },
    ]);
  });
});

describe("toOpenAIMessages", () => {
  it("system prompt jadi pesan developer pertama; teks diteruskan", () => {
    const result = toOpenAIMessages("SYSTEM", [
      { role: "user", content: "Halo" },
      { role: "assistant", content: "Hai" },
    ]);
    assert.deepEqual(result, [
      { role: "developer", content: "SYSTEM" },
      { role: "user", content: "Halo" },
      { role: "assistant", content: "Hai" },
    ]);
  });

  it("system kosong tidak dikirim", () => {
    assert.deepEqual(toOpenAIMessages("", [{ role: "user", content: "x" }]), [
      { role: "user", content: "x" },
    ]);
  });

  it("1 tool call → assistant(tool_calls) lalu pesan role tool", () => {
    const result = toOpenAIMessages("S", [
      { role: "user", content: "Dokumen apa saja?" },
      toolMessage("call_1", "list_uploaded_documents", {}, "[]"),
    ]);
    assert.deepEqual(result.slice(1), [
      { role: "user", content: "Dokumen apa saja?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_uploaded_documents", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "[]" },
    ]);
  });

  it("parallel tool calls: SATU assistant dengan semua tool_calls, lalu pesan tool berurutan", () => {
    const result = toOpenAIMessages("S", [
      { role: "user", content: "Ringkas A dan B" },
      toolMessage("call_a", "get_document_summary", { document_id: "A" }, "ringkasan A"),
      toolMessage("call_b", "get_document_summary", { document_id: "B" }, "ringkasan B"),
    ]);
    assert.deepEqual(
      result.map((m) => m.role),
      ["developer", "user", "assistant", "tool", "tool"],
    );
    const assistant = result[2];
    assert.equal(assistant.role, "assistant");
    if (assistant.role === "assistant") {
      assert.deepEqual(assistant.tool_calls, [
        {
          id: "call_a",
          type: "function",
          function: { name: "get_document_summary", arguments: '{"document_id":"A"}' },
        },
        {
          id: "call_b",
          type: "function",
          function: { name: "get_document_summary", arguments: '{"document_id":"B"}' },
        },
      ]);
    }
    assert.deepEqual(result.slice(3), [
      { role: "tool", tool_call_id: "call_a", content: "ringkasan A" },
      { role: "tool", tool_call_id: "call_b", content: "ringkasan B" },
    ]);
  });

  it("teks assistant lalu tool call → tool_calls ditempel ke pesan assistant itu", () => {
    const result = toOpenAIMessages("S", [
      { role: "user", content: "Ringkas A" },
      { role: "assistant", content: "Saya cek dulu." },
      toolMessage("call_1", "list_uploaded_documents", {}, "[]"),
    ]);
    assert.deepEqual(result.slice(2), [
      {
        role: "assistant",
        content: "Saya cek dulu.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_uploaded_documents", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "[]" },
    ]);
  });

  it("ronde tool kedua setelah teks assistant → pesan assistant baru (tidak menempel ke ronde 1)", () => {
    const result = toOpenAIMessages("S", [
      { role: "user", content: "Ringkas panduan" },
      toolMessage("call_1", "list_uploaded_documents", {}, '[{"id":"A"}]'),
      { role: "assistant", content: "Ketemu." },
      toolMessage("call_2", "get_document_summary", { document_id: "A" }, "ringkasan"),
    ]);
    assert.deepEqual(
      result.map((m) => m.role),
      ["developer", "user", "assistant", "tool", "assistant", "tool"],
    );
    const second = result[4];
    if (second.role === "assistant") {
      assert.equal(second.content, "Ketemu.");
      assert.equal(second.tool_calls?.length, 1);
    }
  });
});

describe("toOpenAITools", () => {
  it("Tool generik → function tool dengan parameters = input_schema", () => {
    assert.deepEqual(toOpenAITools([listTool]), [
      {
        type: "function",
        function: {
          name: "list_uploaded_documents",
          description: "Daftar dokumen",
          parameters: listTool.input_schema,
        },
      },
    ]);
  });
});
