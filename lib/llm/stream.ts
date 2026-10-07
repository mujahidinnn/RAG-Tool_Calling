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
//    bukan jawaban "sukses" yang diam-diam terpotong. Jawaban teks yang
//    berhenti karena batas output ditandai `done.truncated` supaya pemakai
//    bisa memberi tahu user.
// 5. Token yang sudah dilaporkan provider ikut dibawa ProviderError.usage
//    saat stream berakhir dengan error (refusal, terpotong, dll.).

import type { RawMessageStreamEvent, StopReason } from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

import { ProviderError, type AnthropicReplayBlock, type AssistantReplay, type StreamEvent } from "./types";

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

/** Blok giliran assistant selagi di-stream (urut index) — bahan AssistantReplay. */
type AnthropicDraftBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; tool: PendingAnthropicTool };

// parseToolArguments selalu mengembalikan objek; guard ini hanya untuk tipe.
function toInputObject(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * Event Anthropic → StreamEvent.
 *
 * Urutan event Anthropic: message_start (usage input) → per blok konten:
 * content_block_start → content_block_delta × N → content_block_stop →
 * message_delta (stop_reason + usage kumulatif) → message_stop.
 * Blok teks dan blok tool_use bisa diselingi (teks dulu, lalu 1+ tool_use).
 * Blok `thinking` (penalaran internal model) tidak ditampilkan, tapi
 * disimpan bersama tanda tangannya: kalau giliran ini memanggil tool,
 * seluruh isinya dikirim sebagai event `replay` supaya ronde berikutnya bisa
 * mengirimnya balik tanpa diubah (lihat AssistantReplay di types.ts).
 */
export async function* mapAnthropicStream(
  events: AsyncIterable<RawMessageStreamEvent>,
): AsyncGenerator<StreamEvent> {
  // Kunci = index blok konten; tool_use di-buffer per index karena
  // potongan JSON-nya datang lewat beberapa event input_json_delta.
  const openTools = new Map<number, PendingAnthropicTool>();
  const finishedTools: PendingAnthropicTool[] = [];
  const drafts = new Map<number, AnthropicDraftBlock>();
  // Blok jenis lain (mis. tool server) tidak bisa kita kirim balik dengan
  // benar → jangan replay sama sekali (kembali ke rekonstruksi biasa).
  let replayable = true;

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let stopReason: StopReason | null = null;
  let refusalCategory: string | null = null;
  let sawMessageDelta = false;
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
          const tool: PendingAnthropicTool = { id: block.id, name: block.name, json: "" };
          openTools.set(event.index, tool);
          drafts.set(event.index, { type: "tool_use", tool });
        } else if (block.type === "text") {
          drafts.set(event.index, { type: "text", text: block.text });
          if (block.text !== "") yield { type: "text", delta: block.text };
        } else if (block.type === "thinking") {
          drafts.set(event.index, { type: "thinking", thinking: block.thinking, signature: block.signature });
        } else if (block.type === "redacted_thinking") {
          drafts.set(event.index, { type: "redacted_thinking", data: block.data });
        } else {
          replayable = false;
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        const draft = drafts.get(event.index);
        if (delta.type === "text_delta") {
          if (draft?.type === "text") draft.text += delta.text;
          if (delta.text !== "") yield { type: "text", delta: delta.text };
        } else if (delta.type === "input_json_delta") {
          const tool = openTools.get(event.index);
          if (tool) tool.json += delta.partial_json;
        } else if (delta.type === "thinking_delta") {
          if (draft?.type === "thinking") draft.thinking += delta.thinking;
        } else if (delta.type === "signature_delta") {
          if (draft?.type === "thinking") draft.signature += delta.signature;
        }
        // citations_delta: tidak dipakai.
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
        sawMessageDelta = true;
        break;
      }
      case "message_stop": {
        sawMessageStop = true;
        break;
      }
    }
  }

  // Total input = input biasa + token yang dibaca/ditulis ke prompt cache.
  const totalInput = inputTokens + cacheReadTokens + cacheWriteTokens;
  // Angka final hanya ada setelah message_delta. Error di bawah membawanya
  // supaya biaya yang tetap ditagih provider tercatat apa adanya (bukan estimasi).
  const knownUsage = sawMessageDelta ? { inputTokens: totalInput, outputTokens } : undefined;

  if (!sawMessageStop) {
    throw new ProviderError({
      provider: "anthropic",
      code: "network",
      message: "Anthropic: koneksi stream terputus sebelum jawaban selesai. Coba kirim ulang.",
      usage: knownUsage,
    });
  }

  if (stopReason === "refusal") {
    // Refusal bisa memotong tool_use di tengah input → tool turn ini dibuang.
    const category = refusalCategory ? ` (kategori: ${refusalCategory})` : "";
    throw new ProviderError({
      provider: "anthropic",
      code: "refusal",
      message: `Anthropic: Claude menolak menjawab permintaan ini${category}. Coba ubah pertanyaannya.`,
      usage: knownUsage,
    });
  }

  // `model_context_window_exceeded` = output berhenti karena konteks model
  // penuh — sama-sama "terpotong" seperti max_tokens.
  const truncated = stopReason === "max_tokens" || stopReason === "model_context_window_exceeded";
  if (truncated && finishedTools.length > 0) {
    throw new ProviderError({
      provider: "anthropic",
      code: "unknown",
      message:
        "Anthropic: jawaban terpotong (batas panjang output) saat model menyusun pemanggilan tool, jadi tool tidak dijalankan. Coba ulangi dengan pertanyaan yang lebih spesifik.",
      retryable: true,
      usage: knownUsage,
    });
  }

  // Parse 1x: objek yang SAMA dipakai event tool_call dan replay, jadi input
  // tool_use yang dikirim balik selalu identik byte-per-byte di tiap ronde.
  const inputs = new Map(finishedTools.map((tool) => [tool, parseToolArguments(tool.json)] as const));
  const replay = buildAnthropicReplay(drafts, inputs, replayable);
  if (replay) yield { type: "replay", replay };
  for (const tool of finishedTools) {
    yield { type: "tool_call", id: tool.id, name: tool.name, input: inputs.get(tool) };
  }
  yield {
    type: "done",
    inputTokens: totalInput,
    outputTokens,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Susun giliran assistant (urut index blok) untuk dikirim balik. Hanya kalau
 * ada tool call DAN blok thinking — tanpa thinking, rekonstruksi biasa di
 * translate.ts sudah setara.
 */
function buildAnthropicReplay(
  drafts: Map<number, AnthropicDraftBlock>,
  inputs: Map<PendingAnthropicTool, unknown>,
  replayable: boolean,
): AssistantReplay | null {
  if (!replayable || inputs.size === 0) return null;
  const ordered = [...drafts.entries()].sort(([a], [b]) => a - b).map(([, draft]) => draft);
  if (!ordered.some((draft) => draft.type === "thinking" || draft.type === "redacted_thinking")) return null;

  const blocks: AnthropicReplayBlock[] = [];
  for (const draft of ordered) {
    if (draft.type === "tool_use") {
      // tool_use yang tidak selesai (tanpa content_block_stop) tidak pernah dieksekusi.
      if (!inputs.has(draft.tool)) return null;
      blocks.push({ type: "tool_use", id: draft.tool.id, name: draft.tool.name, input: toInputObject(inputs.get(draft.tool)) });
    } else if (draft.type === "text") {
      // API menolak blok teks kosong; blok teks kosong juga tidak ikut dicek tanda tangan thinking.
      if (draft.text.trim() !== "") blocks.push({ type: "text", text: draft.text });
    } else {
      blocks.push(draft);
    }
  }
  return { provider: "anthropic", blocks };
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

  // Usage datang di chunk terakhir, SETELAH finish_reason. Error di bawah
  // membawanya (kalau sudah datang) supaya biaya nyata tercatat, bukan estimasi.
  const knownUsage = usage ?? undefined;

  if (finishReason === null) {
    throw new ProviderError({
      provider: "openai",
      code: "network",
      message: "OpenAI: koneksi stream terputus sebelum jawaban selesai. Coba kirim ulang.",
      usage: knownUsage,
    });
  }

  if (finishReason === "content_filter") {
    throw new ProviderError({
      provider: "openai",
      code: "refusal",
      message: "OpenAI: jawaban diblokir oleh filter konten OpenAI. Coba ubah pertanyaannya.",
      usage: knownUsage,
    });
  }

  if (refusal.trim() !== "") {
    throw new ProviderError({
      provider: "openai",
      code: "refusal",
      message: `OpenAI: GPT menolak menjawab — "${truncate(refusal.trim(), 200)}"`,
      usage: knownUsage,
    });
  }

  // Urutkan sesuai index supaya urutan tool call sama dengan urutan dari model.
  const finishedTools = [...tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);

  const truncated = finishReason === "length";
  if (truncated && finishedTools.length > 0) {
    throw new ProviderError({
      provider: "openai",
      code: "unknown",
      message:
        "OpenAI: jawaban terpotong (batas panjang output) saat model menyusun pemanggilan tool, jadi tool tidak dijalankan. Coba ulangi dengan pertanyaan yang lebih spesifik.",
      retryable: true,
      usage: knownUsage,
    });
  }

  for (const tool of finishedTools) {
    // Tanpa id/nama, hasil tool tidak bisa dipasangkan kembali → abaikan
    // potongan yang tidak lengkap (seharusnya tidak terjadi di API resmi).
    if (!tool.id || !tool.name) continue;
    yield { type: "tool_call", id: tool.id, name: tool.name, input: parseToolArguments(tool.args) };
  }

  // Chunk usage hilang = stream terganggu setelah finish_reason (mis. client
  // memutus koneksi: SDK lalu berhenti TANPA error). Jawabannya tetap utuh,
  // tapi `done` 0/0 akan tercatat sebagai biaya $0 → event `done` sengaja
  // TIDAK dikirim, supaya pemakai jatuh ke jalur estimasi (lib/server/usage-estimate.ts).
  if (usage === null) return;
  yield {
    type: "done",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(truncated ? { truncated: true } : {}),
  };
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
 *
 * `usageReported` false = provider tidak pernah mengirim `done` (angka token
 * 0 di sini TIDAK berarti gratis) → pemanggil sebaiknya mencatat estimasi.
 * `onEvent` dipanggil untuk tiap event — mis. untuk tahu teks yang sudah
 * keluar kalau stream gagal di tengah jalan.
 */
export async function collectStream(
  stream: AsyncIterable<StreamEvent>,
  onEvent?: (event: StreamEvent) => void,
): Promise<{
  text: string;
  toolCalls: CollectedToolCall[];
  inputTokens: number;
  outputTokens: number;
  usageReported: boolean;
}> {
  let text = "";
  const toolCalls: CollectedToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let usageReported = false;

  for await (const event of stream) {
    onEvent?.(event);
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
        usageReported = true;
        break;
    }
  }

  return { text, toolCalls, inputTokens, outputTokens, usageReported };
}
