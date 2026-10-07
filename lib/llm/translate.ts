// Penerjemah format generik (lib/llm/types.ts) → format asli tiap provider.
//
// File ini PURE: hanya mengimpor TIPE dari SDK (`import type`), tanpa
// server-only / env, supaya aturan penerjemahan yang rawan bug bisa dites
// dengan `node --test` (lihat tests/translate.test.ts).
//
// Inti masalahnya: riwayat generik kita menyimpan hasil tool sebagai 1 pesan
// `{ role: "tool", toolCallId, toolName, input, content }`. Kedua provider
// butuh DUA bagian — "panggilan" (dari assistant) dan "hasil" — yang
// dipasangkan lewat id. Penerjemah merekonstruksi keduanya dari 1 pesan itu.

import type {
  ContentBlockParam,
  MessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import type { Message, Tool } from "./types";

type ToolMessage = Extract<Message, { role: "tool" }>;

// Input tool di Anthropic WAJIB berupa objek JSON. Input yang bukan objek
// (null, array, string) hanya mungkin muncul dari bug — ganti dengan {}
// daripada membuat seluruh request ditolak 400.
function toToolInputObject(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

type AnthropicTurn = { role: "user" | "assistant"; blocks: ContentBlockParam[] };

function isToolResultTurn(turn: AnthropicTurn | undefined): boolean {
  return (
    turn !== undefined &&
    turn.role === "user" &&
    turn.blocks.length > 0 &&
    turn.blocks.every((block) => block.type === "tool_result")
  );
}

/**
 * Riwayat generik → `messages` Anthropic.
 *
 * Aturan:
 * - Pesan `tool` → blok `tool_use` di giliran assistant SEBELUMNYA (dibuat
 *   kalau belum ada; digabung kalau sebelumnya assistant berisi teks) +
 *   blok `tool_result` (tool_use_id = toolCallId) di giliran user SESUDAHNYA.
 * - Pesan `tool` yang BERURUTAN (parallel tool calls) berbagi SATU giliran
 *   assistant dan SATU giliran user — Anthropic meminta semua tool_result
 *   dari satu giliran dikirim dalam satu pesan user.
 *   Trade-off: tanpa penanda batas ronde, 2 ronde tool berturut-turut tanpa
 *   teks di antaranya juga digabung jadi 1 ronde paralel. Transkripnya tetap
 *   valid dan informasinya sama, jadi ini disengaja demi format yang sederhana.
 * - Pesan dengan role sama yang berurutan digabung (giliran user/assistant
 *   harus bergantian) dan blok teks kosong dibuang (API menolak teks kosong).
 * - Giliran pertama harus `user`: giliran assistant di awal (mis. riwayat
 *   yang terpotong di tengah) dibuang.
 * - Riwayat dari UI hanya berisi teks (tanpa blok `thinking`) — API
 *   menerimanya. Tapi DI DALAM 1 loop tool, pesan assistant yang membawa
 *   `replay` dikirim sebagai giliran asli Claude apa adanya (thinking +
 *   tanda tangan + teks + tool_use, urutan asli): dokumentasi Claude meminta
 *   blok thinking dikirim balik tanpa diubah selama loop tool. Pesan `tool`
 *   yang tool_use-nya sudah ada di giliran replay itu hanya menambah tool_result.
 * - Tool yang gagal (`isError`) dikirim dengan `is_error: true`, sinyal
 *   kegagalan resmi yang dikenali model (dokumentasi tool use Claude).
 */
export function toAnthropicMessages(messages: Message[]): MessageParam[] {
  const turns: AnthropicTurn[] = [];
  // tool_use id yang sudah dikirim lewat giliran replay.
  const replayedToolIds = new Set<string>();
  // Giliran replay tidak boleh ditambahi blok lain: isinya terikat tanda
  // tangan thinking, dan ronde berikutnya adalah giliran terpisah.
  const sealedTurns = new WeakSet<AnthropicTurn>();

  const lastTurn = (): AnthropicTurn | undefined => turns[turns.length - 1];
  const turnFor = (role: AnthropicTurn["role"]): AnthropicTurn => {
    const last = lastTurn();
    if (last && last.role === role) return last;
    const turn: AnthropicTurn = { role, blocks: [] };
    turns.push(turn);
    return turn;
  };

  for (const message of messages) {
    if (message.role === "tool") {
      if (replayedToolIds.has(message.toolCallId)) appendToolResultOnly(turns, message);
      else appendAnthropicToolMessage(turns, message, turnFor, sealedTurns);
      continue;
    }
    if (message.role === "assistant" && message.replay?.provider === "anthropic") {
      // Giliran asli — `content` (teksnya) sudah termasuk di dalam blok replay.
      for (const block of message.replay.blocks) {
        if (block.type === "tool_use") replayedToolIds.add(block.id);
      }
      const turn = turnFor("assistant");
      turn.blocks.push(...message.replay.blocks);
      sealedTurns.add(turn);
      continue;
    }
    if (message.content.trim() === "") continue;
    turnFor(message.role).blocks.push({ type: "text", text: message.content });
  }

  while (turns.length > 0 && turns[0].role === "assistant") turns.shift();

  return turns.map((turn) => {
    const [first] = turn.blocks;
    // 1 blok teks → kirim sebagai string biasa (bentuk paling umum & ringkas).
    if (turn.blocks.length === 1 && first.type === "text") {
      return { role: turn.role, content: first.text };
    }
    return { role: turn.role, content: turn.blocks };
  });
}

function appendAnthropicToolMessage(
  turns: AnthropicTurn[],
  message: ToolMessage,
  turnFor: (role: AnthropicTurn["role"]) => AnthropicTurn,
  sealedTurns: WeakSet<AnthropicTurn>,
): void {
  const toolUse: ContentBlockParam = {
    type: "tool_use",
    id: message.toolCallId,
    name: message.toolName,
    input: toToolInputObject(message.input),
  };
  const toolResult = toAnthropicToolResult(message);

  const last = turns[turns.length - 1];
  const beforeLast = turns[turns.length - 2];
  if (isToolResultTurn(last) && beforeLast?.role === "assistant" && !sealedTurns.has(beforeLast)) {
    // Lanjutan batch paralel: panggilan masuk ke assistant yang sama,
    // hasilnya ke pesan user yang sama.
    beforeLast.blocks.push(toolUse);
    last.blocks.push(toolResult);
    return;
  }
  turnFor("assistant").blocks.push(toolUse);
  turns.push({ role: "user", blocks: [toolResult] });
}

function toAnthropicToolResult(message: ToolMessage): ContentBlockParam {
  return {
    type: "tool_result",
    tool_use_id: message.toolCallId,
    content: message.content,
    ...(message.isError ? { is_error: true } : {}),
  };
}

/** Hasil tool untuk tool_use yang sudah ada di giliran replay: hanya tool_result. */
function appendToolResultOnly(turns: AnthropicTurn[], message: ToolMessage): void {
  const last = turns[turns.length - 1];
  // Hasil paralel dari 1 giliran → 1 pesan user yang sama.
  if (isToolResultTurn(last)) last.blocks.push(toAnthropicToolResult(message));
  else turns.push({ role: "user", blocks: [toAnthropicToolResult(message)] });
}

/**
 * Definisi tool generik → format Anthropic. `input_schema` sudah JSON Schema,
 * jadi diteruskan apa adanya.
 *
 * `eager_input_streaming: true` = input tool di-stream tanpa di-buffer &
 * divalidasi server (default yang dianjurkan untuk request streaming).
 * Konsekuensinya input bisa berupa JSON rusak/terpotong — karena itu
 * lib/llm/stream.ts mem-parse secara ketat, dan tiap tool memvalidasi
 * inputnya dengan zod sebelum dieksekusi.
 */
export function toAnthropicTools(tools: Tool[]): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    eager_input_streaming: true,
  }));
}

// ---------------------------------------------------------------------------
// OpenAI (Chat Completions)
// ---------------------------------------------------------------------------

/**
 * Riwayat generik → `messages` Chat Completions.
 *
 * - System prompt dikirim sebagai pesan role `developer`: untuk model
 *   reasoning OpenAI (o1 ke atas, termasuk keluarga GPT-5), `developer`
 *   menggantikan `system` (lihat dokumentasi tipe di SDK openai).
 * - `replay` (khusus Anthropic) diabaikan; `isError` tidak punya padanan di
 *   OpenAI — pesan error-nya sudah ada di `content`.
 * - Pesan `tool` → `tool_calls` pada pesan assistant (dibuat kalau belum ada;
 *   ditempel ke assistant teks tepat sebelumnya) diikuti pesan
 *   `{ role: "tool", tool_call_id, content }`. Pesan tool berurutan (paralel)
 *   berbagi SATU pesan assistant, lalu pesan-pesan `tool` menyusul dengan
 *   urutan yang sama — OpenAI mewajibkan tiap tool_call_id dijawab tepat
 *   setelah pesan assistant yang memanggilnya.
 */
export function toOpenAIMessages(system: string, messages: Message[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  if (system.trim() !== "") result.push({ role: "developer", content: system });

  // Pesan assistant yang sedang menampung tool_calls batch saat ini. Di-reset
  // setiap ada pesan user/assistant baru supaya ronde berikutnya mulai baru.
  let openToolCallTurn: ChatCompletionAssistantMessageParam | null = null;

  for (const message of messages) {
    if (message.role !== "tool") {
      openToolCallTurn = null;
      result.push({ role: message.role, content: message.content });
      continue;
    }

    if (openToolCallTurn === null) {
      const previous = result[result.length - 1];
      if (previous?.role === "assistant" && !previous.tool_calls?.length) {
        openToolCallTurn = previous; // tempel ke assistant teks sebelumnya
      } else {
        openToolCallTurn = { role: "assistant", content: null };
        result.push(openToolCallTurn);
      }
    }

    openToolCallTurn.tool_calls = [
      ...(openToolCallTurn.tool_calls ?? []),
      {
        id: message.toolCallId,
        type: "function",
        function: {
          name: message.toolName,
          arguments: JSON.stringify(toToolInputObject(message.input)),
        },
      },
    ];
    result.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
  }

  return result;
}

/** Definisi tool generik → format function tool OpenAI. */
export function toOpenAITools(tools: Tool[]): ChatCompletionFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}
