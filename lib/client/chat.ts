// State percakapan di client + reducer murni yang menerapkan event SSE.
//
// Dipisah dari komponen React supaya alurnya bisa dibaca (dan dites) tanpa
// UI: "event apa mengubah state apa". ChatPanel cukup memanggil
// `dispatch({ type: "event", ... })` untuk tiap event dari server.
//
// PURE: tanpa React/DOM — dites di tests/chat-state.test.ts.

import { MAX_HISTORY_MESSAGE_CHARS, MAX_HISTORY_MESSAGES } from "@/lib/config";
import type {
  ApiErrorCode,
  ChatHistoryMessage,
  ChatStreamEvent,
  ProviderName,
  Source,
  ToolCardPayload,
} from "@/lib/types";

export type ChatErrorInfo = {
  code: ApiErrorCode | "network";
  message: string;
  retryable: boolean;
  provider?: ProviderName;
  /** Epoch ms: tombol retry dinonaktifkan sampai waktu ini (setelah rate limit). */
  retryAt?: number;
};

/**
 * Isi pesan assistant disimpan sebagai urutan "part" (bukan 1 string) supaya
 * urutan waktunya terjaga: teks → card tool → teks lanjutan. Kalau semua teks
 * digabung, kalimat sebelum & sesudah tool call akan menempel tanpa jeda.
 */
export type MessagePart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      /** null = tool masih dijalankan di server. */
      result: ToolCardPayload | null;
    };

export type AssistantStatus =
  | "pending" // menunggu event pertama (rewrite/retrieval)
  | "streaming" // teks / tool sedang masuk
  | "done"
  | "error"
  | "stopped"; // dihentikan user

export type UserTurn = { id: string; role: "user"; content: string };

export type AssistantTurn = {
  id: string;
  role: "assistant";
  /** Id UserTurn yang dijawab — dipakai untuk retry. */
  replyTo: string;
  question: string;
  provider: ProviderName;
  label: string;
  model: string | null;
  status: AssistantStatus;
  parts: MessagePart[];
  /** null = event `sources` belum datang (masih mencari). */
  sources: Source[] | null;
  searchQuery: string | null;
  rewritten: boolean;
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  error: ChatErrorInfo | null;
};

export type ChatTurn = UserTurn | AssistantTurn;

export function createAssistantTurn(init: {
  id: string;
  replyTo: string;
  question: string;
  provider: ProviderName;
  label: string;
}): AssistantTurn {
  return {
    ...init,
    role: "assistant",
    model: null,
    status: "pending",
    parts: [],
    sources: null,
    searchQuery: null,
    rewritten: false,
    usage: null,
    error: null,
  };
}

function isFinished(status: AssistantStatus): boolean {
  return status === "done" || status === "error" || status === "stopped";
}

function appendText(parts: MessagePart[], delta: string): MessagePart[] {
  const last = parts.at(-1);
  if (last && last.type === "text") {
    return [...parts.slice(0, -1), { type: "text", text: last.text + delta }];
  }
  return [...parts, { type: "text", text: delta }];
}

/** Terapkan 1 event SSE ke pesan assistant (immutable). */
export function applyStreamEvent(turn: AssistantTurn, event: ChatStreamEvent): AssistantTurn {
  switch (event.type) {
    case "meta":
      return {
        ...turn,
        provider: event.provider,
        label: event.label,
        model: event.model,
        searchQuery: event.searchQuery,
        rewritten: event.rewritten,
      };
    case "sources":
      return { ...turn, sources: event.sources };
    case "text":
      if (event.delta.length === 0) return turn;
      return { ...turn, status: "streaming", parts: appendText(turn.parts, event.delta) };
    case "tool_call":
      return {
        ...turn,
        status: "streaming",
        parts: [
          ...turn.parts,
          { type: "tool", id: event.id, name: event.name, input: event.input, result: null },
        ],
      };
    case "tool_result": {
      let matched = false;
      const parts = turn.parts.map((part): MessagePart => {
        if (part.type !== "tool" || part.id !== event.id) return part;
        matched = true;
        return { ...part, result: event.payload };
      });
      // tool_result tanpa tool_call sebelumnya (seharusnya tidak terjadi) tetap ditampilkan.
      if (!matched) {
        parts.push({ type: "tool", id: event.id, name: event.name, input: null, result: event.payload });
      }
      return { ...turn, parts };
    }
    case "usage":
      return {
        ...turn,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd,
        },
      };
    case "error":
      return {
        ...turn,
        status: "error",
        error: {
          code: event.code,
          message: event.message,
          retryable: event.retryable,
          provider: event.provider,
        },
      };
    case "done":
      return turn.status === "error" ? turn : { ...turn, status: "done" };
  }
}

/**
 * Dipanggil saat stream berakhir. Kalau server menutup koneksi tanpa `done`
 * (mis. timeout platform / jaringan putus), jangan biarkan UI "streaming"
 * selamanya — tampilkan error yang bisa di-retry.
 */
export function finishTurn(turn: AssistantTurn, reason: "ended" | "aborted"): AssistantTurn {
  if (isFinished(turn.status)) return turn;
  if (reason === "aborted") return { ...turn, status: "stopped" };
  return {
    ...turn,
    status: "error",
    error: {
      code: "network",
      message: "Koneksi terputus sebelum jawaban selesai.",
      retryable: true,
    },
  };
}

export function failTurn(turn: AssistantTurn, error: ChatErrorInfo): AssistantTurn {
  return { ...turn, status: "error", error };
}

/** Gabungan semua teks jawaban (tanpa card tool). */
export function assistantText(turn: AssistantTurn): string {
  return turn.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
}

export function isStreaming(turn: AssistantTurn): boolean {
  return turn.status === "pending" || turn.status === "streaming";
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Riwayat yang dikirim ke server untuk pertanyaan berikutnya.
 * - Hanya pasangan tanya-jawab yang BERHASIL (jawaban gagal/kosong tidak ikut,
 *   supaya model tidak "melanjutkan" pesan error).
 * - Dibatasi MAX_HISTORY_MESSAGES & MAX_HISTORY_MESSAGE_CHARS: server
 *   memvalidasi batas yang sama dan menolak (400) kalau dilanggar.
 */
export function buildHistory(turns: readonly ChatTurn[]): ChatHistoryMessage[] {
  const history: ChatHistoryMessage[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== "user") continue;
    const reply = turns[i + 1];
    if (!reply || reply.role !== "assistant") continue;
    if (reply.status !== "done" && reply.status !== "stopped") continue;
    const answer = assistantText(reply);
    if (answer.length === 0) continue;
    history.push(
      { role: "user", content: truncate(turn.content, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "assistant", content: truncate(answer, MAX_HISTORY_MESSAGE_CHARS) },
    );
  }
  return history.slice(-MAX_HISTORY_MESSAGES);
}

// --- Reducer --------------------------------------------------------------------------

export type ChatAction =
  | { type: "ask"; user: UserTurn; assistant: AssistantTurn }
  | { type: "retry"; failedId: string; assistant: AssistantTurn }
  | { type: "event"; id: string; event: ChatStreamEvent }
  | { type: "finish"; id: string; reason: "ended" | "aborted" }
  | { type: "fail"; id: string; error: ChatErrorInfo }
  | { type: "reset" };

function updateAssistant(
  turns: ChatTurn[],
  id: string,
  update: (turn: AssistantTurn) => AssistantTurn,
): ChatTurn[] {
  return turns.map((turn) => (turn.role === "assistant" && turn.id === id ? update(turn) : turn));
}

export function chatReducer(turns: ChatTurn[], action: ChatAction): ChatTurn[] {
  switch (action.type) {
    case "ask":
      return [...turns, action.user, action.assistant];
    case "retry":
      // Ganti jawaban yang gagal dengan jawaban baru di posisi yang sama.
      return turns.map((turn) => (turn.id === action.failedId ? action.assistant : turn));
    case "event":
      return updateAssistant(turns, action.id, (turn) => applyStreamEvent(turn, action.event));
    case "finish":
      return updateAssistant(turns, action.id, (turn) => finishTurn(turn, action.reason));
    case "fail":
      return updateAssistant(turns, action.id, (turn) => failTurn(turn, action.error));
    case "reset":
      return [];
  }
}
