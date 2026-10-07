// Penyeragaman stream: event mentah SDK Anthropic / OpenAI → 3 StreamEvent
// generik (text | tool_call | done). Inilah inti "adapter" multi-provider —
// sisa aplikasi (API route, UI) tidak perlu tahu provider mana yang dipakai.
//
// File ini PURE: fungsi-fungsinya hanya menerima AsyncIterable berisi event
// (bentuk tipenya dari SDK, diimpor sebagai `import type`), jadi bisa dites
// dengan urutan event palsu tanpa jaringan (tests/llm-stream.test.ts).
//
// Keputusan desain yang sama untuk kedua provider:
// 1. Teks diteruskan SEGERA (token-by-token) supaya streaming terasa di UI.
// 2. Tool call DITAHAN sampai stream selesai, baru dikirim setelah stop
//    reason diketahui. Alasannya: kalau output terpotong (max_tokens) atau
//    model menolak (refusal), input tool bisa setengah jadi — tool seperti
//    itu tidak boleh dieksekusi. API route memang baru menjalankan tool
//    setelah satu ronde stream selesai, jadi menahan tidak menambah latensi.
// 3. Argumen tool di-parse KETAT dengan JSON.parse (bukan parser toleran)
//    lalu dicek harus berupa objek — lihat parseToolArguments().
// 4. Stream yang berhenti tanpa penanda selesai dianggap terputus → error,
//    bukan jawaban "sukses" yang diam-diam terpotong.

import type { RawMessageStreamEvent, StopReason } from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

import { ProviderError, type StreamEvent } from "./types";

export type CollectedToolCall = { id: string; name: string; input: unknown };

/**
 * Hasil parse argumen tool. Kalau JSON rusak / bukan objek, model TIDAK
 * dibuat gagal total: kita kirim penanda `{ INVALID_JSON: "<teks mentah>" }`
 * sebagai input. Validasi zod di tool akan menolaknya dan pesan errornya
 * dikembalikan ke model sebagai hasil tool, sehingga model bisa mencoba lagi
 * (pola yang dianjurkan dokumentasi tool use Anthropic untuk input rusak).
 */
export function parseToolArguments(raw: string): unknown {
  if (raw.trim() === "") return {}; // tool tanpa parameter boleh mengirim argumen kosong
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    // jatuh ke penanda di bawah
  }
  return { INVALID_JSON: raw };
}

// Jumlah token dari payload API. Tipe SDK menyebut field usage selalu ada,
// tapi di wire field bisa null ATAU tidak dikirim sama sekali (mis. versi
// API lama hanya mengirim `output_tokens` di message_delta). Tanpa cek ini,
// `undefined + 0` = NaN → biaya & daily cap ikut rusak diam-diam.
function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Anthropic (Messages API, event SSE mentah)
// ---------------------------------------------------------------------------

type PendingAnthropicTool = { id: string; name: string; json: string };

/**
 * Event Anthropic → StreamEvent.
 *
 * Urutan event Anthropic: message_start (usage input) → per blok konten:
 * content_block_start → content_block_delta × N → content_block_stop →
 * message_delta (stop_reason + usage kumulatif) → message_stop.
 * Blok teks dan blok tool_use bisa diselingi (teks dulu, lalu 1+ tool_use).
 * Blok `thinking` (penalaran internal model) diabaikan — tidak ditampilkan.
 */
export async function* mapAnthropicStream(
  events: AsyncIterable<RawMessageStreamEvent>,
): AsyncGenerator<StreamEvent> {
  // Kunci = index blok konten; tool_use di-buffer per index karena
  // potongan JSON-nya datang lewat beberapa event input_json_delta.
  const openTools = new Map<number, PendingAnthropicTool>();
  const finishedTools: PendingAnthropicTool[] = [];

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let stopReason: StopReason | null = null;
  let refusalCategory: string | null = null;
  let sawMessageStop = false;

  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        const usage = event.message.usage;
        if (isTokenCount(usage.input_tokens)) inputTokens = usage.input_tokens;
        if (isTokenCount(usage.cache_read_input_tokens)) cacheReadTokens = usage.cache_read_input_tokens;
        if (isTokenCount(usage.cache_creation_input_tokens)) {
          cacheWriteTokens = usage.cache_creation_input_tokens;
        }
        if (isTokenCount(usage.output_tokens)) outputTokens = usage.output_tokens;
        break;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "tool_use") {
          openTools.set(event.index, { id: block.id, name: block.name, json: "" });
        } else if (block.type === "text" && block.text !== "") {
          yield { type: "text", delta: block.text };
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          if (delta.text !== "") yield { type: "text", delta: delta.text };
        } else if (delta.type === "input_json_delta") {
          const tool = openTools.get(event.index);
          if (tool) tool.json += delta.partial_json;
        }
        // thinking_delta / signature_delta / citations_delta: tidak dipakai.
        break;
      }
      case "content_block_stop": {
        const tool = openTools.get(event.index);
        if (tool) {
          openTools.delete(event.index);
          finishedTools.push(tool);
        }
        break;
      }
      case "message_delta": {
        // Usage di message_delta bersifat KUMULATIF (bukan tambahan), jadi
        // ditimpa, bukan dijumlah. Field yang null/tidak ada = tidak berubah.
        const usage = event.usage;
        if (isTokenCount(usage.input_tokens)) inputTokens = usage.input_tokens;
        if (isTokenCount(usage.cache_read_input_tokens)) cacheReadTokens = usage.cache_read_input_tokens;
        if (isTokenCount(usage.cache_creation_input_tokens)) {
          cacheWriteTokens = usage.cache_creation_input_tokens;
        }
        if (isTokenCount(usage.output_tokens)) outputTokens = usage.output_tokens;
        if (event.delta.stop_reason !== null) stopReason = event.delta.stop_reason;
        refusalCategory = event.delta.stop_details?.category ?? refusalCategory;
        break;
      }
      case "message_stop": {
        sawMessageStop = true;
        break;
      }
    }
  }

  if (!sawMessageStop) {
    throw new ProviderError({
      provider: "anthropic",
      code: "network",
      message: "Anthropic: koneksi stream terputus sebelum jawaban selesai. Coba kirim ulang.",
    });
  }

  if (stopReason === "refusal") {
    // Refusal bisa memotong tool_use di tengah input → tool turn ini dibuang.
    const category = refusalCategory ? ` (kategori: ${refusalCategory})` : "";
    throw new ProviderError({
      provider: "anthropic",
      code: "refusal",
      message: `Anthropic: Claude menolak menjawab permintaan ini${category}. Coba ubah pertanyaannya.`,
    });
  }

  if (stopReason === "max_tokens" && finishedTools.length > 0) {
    throw new ProviderError({
      provider: "anthropic",
      code: "unknown",
      message:
        "Anthropic: jawaban terpotong (batas panjang output) saat model menyusun pemanggilan tool, jadi tool tidak dijalankan. Coba ulangi dengan pertanyaan yang lebih spesifik.",
      retryable: true,
    });
  }

  for (const tool of finishedTools) {
    yield { type: "tool_call", id: tool.id, name: tool.name, input: parseToolArguments(tool.json) };
  }
  yield {
    type: "done",
    // Total input = input biasa + token yang dibaca/ditulis ke prompt cache.
    inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// OpenAI (Chat Completions, chunk streaming)
// ---------------------------------------------------------------------------

type PendingOpenAITool = { id: string; name: string; args: string };
type FinishReason = ChatCompletionChunk.Choice["finish_reason"];

/**
 * Chunk OpenAI → StreamEvent.
 *
 * Bedanya dengan Anthropic: tidak ada event "blok mulai/selesai". Tool call
 * datang sebagai potongan `delta.tool_calls[]` yang dibedakan lewat `index`
 * — `id` & `name` hanya ada di potongan pertama, `function.arguments` datang
 * sebagai potongan string yang harus disambung. Beberapa tool call paralel
 * bisa saling selang-seling. Usage datang di chunk TERAKHIR yang `choices`-nya
 * kosong (karena `stream_options.include_usage: true`).
 */
export async function* mapOpenAIStream(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<StreamEvent> {
  const tools = new Map<number, PendingOpenAITool>();
  let refusal = "";
  let finishReason: FinishReason = null;
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  for await (const chunk of chunks) {
    if (chunk.usage) {
      const { prompt_tokens: input, completion_tokens: output } = chunk.usage;
      usage = {
        inputTokens: isTokenCount(input) ? input : 0,
        outputTokens: isTokenCount(output) ? output : 0,
      };
    }

    // Kita selalu meminta 1 jawaban (n = 1), jadi cukup choice index 0.
    const choice = chunk.choices.find((c) => c.index === 0);
    if (!choice) continue;

    const delta = choice.delta;
    if (delta.content) yield { type: "text", delta: delta.content };
    // Teks refusal TIDAK di-stream sebagai jawaban; ditampilkan sebagai error.
    if (delta.refusal) refusal += delta.refusal;

    for (const part of delta.tool_calls ?? []) {
      let tool = tools.get(part.index);
      if (!tool) {
        tool = { id: "", name: "", args: "" };
        tools.set(part.index, tool);
      }
      if (part.id) tool.id = part.id;
      if (part.function?.name) tool.name = part.function.name;
      if (part.function?.arguments) tool.args += part.function.arguments;
    }

    if (choice.finish_reason !== null) finishReason = choice.finish_reason;
  }

  if (finishReason === null) {
    throw new ProviderError({
      provider: "openai",
      code: "network",
      message: "OpenAI: koneksi stream terputus sebelum jawaban selesai. Coba kirim ulang.",
    });
  }

  if (finishReason === "content_filter") {
    throw new ProviderError({
      provider: "openai",
      code: "refusal",
      message: "OpenAI: jawaban diblokir oleh filter konten OpenAI. Coba ubah pertanyaannya.",
    });
  }

  if (refusal.trim() !== "") {
    throw new ProviderError({
      provider: "openai",
      code: "refusal",
      message: `OpenAI: GPT menolak menjawab — "${truncate(refusal.trim(), 200)}"`,
    });
  }

  // Urutkan sesuai index supaya urutan tool call sama dengan urutan dari model.
  const finishedTools = [...tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);

  if (finishReason === "length" && finishedTools.length > 0) {
    throw new ProviderError({
      provider: "openai",
      code: "unknown",
      message:
        "OpenAI: jawaban terpotong (batas panjang output) saat model menyusun pemanggilan tool, jadi tool tidak dijalankan. Coba ulangi dengan pertanyaan yang lebih spesifik.",
      retryable: true,
    });
  }

  for (const tool of finishedTools) {
    // Tanpa id/nama, hasil tool tidak bisa dipasangkan kembali → abaikan
    // potongan yang tidak lengkap (seharusnya tidak terjadi di API resmi).
    if (!tool.id || !tool.name) continue;
    yield { type: "tool_call", id: tool.id, name: tool.name, input: parseToolArguments(tool.args) };
  }

  // Usage hilang hanya kalau stream terganggu setelah finish_reason. Jawaban
  // tetap dianggap sukses (teksnya lengkap), tapi token tercatat 0.
  yield { type: "done", inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Helper untuk pemakai yang butuh hasil utuh (query rewriting, ringkasan)
// ---------------------------------------------------------------------------

/**
 * Habiskan stream dan kumpulkan hasilnya: teks lengkap, semua tool call,
 * dan total token. Error dari provider diteruskan apa adanya (ProviderError).
 */
export async function collectStream(stream: AsyncIterable<StreamEvent>): Promise<{
  text: string;
  toolCalls: CollectedToolCall[];
  inputTokens: number;
  outputTokens: number;
}> {
  let text = "";
  const toolCalls: CollectedToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of stream) {
    switch (event.type) {
      case "text":
        text += event.delta;
        break;
      case "tool_call":
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
        break;
      case "done":
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        break;
    }
  }

  return { text, toolCalls, inputTokens, outputTokens };
}
