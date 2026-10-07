// Kontrak adapter multi-LLM. File ini hanya berisi tipe + 1 class error,
// tanpa import SDK, supaya bisa dipakai di mana saja (termasuk test).

export type ProviderName = "anthropic" | "openai";

/**
 * Pesan generik yang dimengerti semua adapter.
 *
 * Pesan `tool` membawa `toolCallId` + `input` (sedikit lebih kaya dari versi
 * minimal) karena KEDUA provider mewajibkan hasil tool dipasangkan dengan
 * panggilan aslinya: Anthropic lewat `tool_use.id` ↔ `tool_result.tool_use_id`,
 * OpenAI lewat `tool_calls[].id` ↔ pesan `role: "tool"` + `tool_call_id`.
 * Adapter merekonstruksi giliran assistant (yang berisi panggilan tool) dari
 * data ini, lalu menaruh hasilnya di format asli provider.
 */
export type Message =
  | {
      role: "user" | "assistant";
      content: string;
      /**
       * Hanya untuk `assistant` di DALAM 1 loop tool (1 request /api/chat):
       * isi giliran asli provider yang harus dikirim balik apa adanya
       * (lihat AssistantReplay). Riwayat dari UI tidak pernah membawanya.
       */
      replay?: AssistantReplay;
    }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** Hasil eksekusi tool dalam bentuk string (biasanya JSON). */
      content: string;
      /** true kalau tool GAGAL — Anthropic menerimanya sebagai `is_error: true`. */
      isError?: boolean;
    };

/**
 * Blok konten giliran assistant Anthropic yang dikirim balik tanpa diubah.
 * Bentuknya sama dengan tipe param SDK (ThinkingBlockParam dst.), ditulis
 * ulang di sini supaya file ini tetap tanpa import SDK.
 */
export type AnthropicReplayBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/**
 * Giliran assistant persis seperti dihasilkan provider, untuk dikirim balik
 * di ronde tool berikutnya. Kenapa perlu: Claude (adaptive thinking) memberi
 * blok `thinking` bertanda tangan sebelum tool_use; dokumentasi Claude
 * meminta blok itu dikirim balik TANPA diubah selama loop tool supaya model
 * tidak kehilangan penalarannya di antara ronde. Riwayat generik kita (teks
 * + pesan `tool`) tidak bisa membawanya, jadi disimpan utuh di sini.
 */
export type AssistantReplay = { provider: "anthropic"; blocks: AnthropicReplayBlock[] };

/** JSON Schema objek (subset) — dipakai apa adanya oleh kedua provider. */
export type JsonSchemaObject = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/** Definisi tool generik — ditulis 1x, diterjemahkan oleh tiap adapter. */
export type Tool = {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
};

/**
 * Event generik hasil penyeragaman stream Anthropic & OpenAI: 3 event inti
 * (text | tool_call | done) + `replay` (khusus loop tool, lihat AssistantReplay).
 */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  /** Dikirim sebelum event tool_call kalau giliran ini perlu dikirim balik utuh. */
  | { type: "replay"; replay: AssistantReplay }
  | {
      type: "done";
      inputTokens: number;
      outputTokens: number;
      /**
       * true = jawaban berhenti karena batas panjang output (Anthropic
       * `max_tokens` / `model_context_window_exceeded`, OpenAI `length`),
       * bukan karena model selesai. Tidak ada = selesai normal.
       */
      truncated?: boolean;
    };

export type ChatOptions = {
  /**
   * Override system prompt. Default: buildSystemPrompt(context) dari
   * lib/rag/prompt.ts. Dipakai untuk query rewriting & ringkasan dokumen.
   */
  system?: string;
  /** Default: MAX_OUTPUT_TOKENS dari lib/config.ts. */
  maxOutputTokens?: number;
  /**
   * "none" = model DILARANG memanggil tool di panggilan ini (dipakai di ronde
   * terakhir loop tool). Tools tetap dikirim: Anthropic menolak riwayat berisi
   * tool_use/tool_result tanpa `tools`, jadi cara mematikan tool yang benar
   * adalah tool_choice "none", bukan menghapus definisi tools. Default "auto".
   */
  toolChoice?: "auto" | "none";
  /** Dibatalkan saat client menutup koneksi. */
  signal?: AbortSignal;
};

export interface ChatProvider {
  name: ProviderName;
  /** ID model yang dipakai, mis. "claude-sonnet-5-5". Kunci untuk pricing. */
  model: string;
  /** Label pendek untuk badge UI: "Claude" | "GPT". */
  label: string;
  streamChat(
    messages: Message[],
    context: string,
    tools?: Tool[],
    options?: ChatOptions,
  ): AsyncIterable<StreamEvent>;
}

export type ProviderErrorCode =
  | "missing_key" // API key provider tidak di-set
  | "auth" // API key salah / dicabut (401/403)
  | "rate_limit" // 429 dari provider
  | "overloaded" // 5xx / 529 dari provider
  | "bad_request" // 400 (request tidak valid)
  | "refusal" // model menolak menjawab (stop_reason/finish_reason)
  | "network" // gagal konek / timeout
  | "aborted" // dibatalkan client
  | "unknown";

/**
 * Error terstandar dari adapter. TIDAK ada auto-fallback ke provider lain:
 * error ini diteruskan apa adanya ke UI supaya user tahu provider mana yang
 * gagal dan kenapa (penting untuk observability).
 */
export type TokenUsage = { inputTokens: number; outputTokens: number };

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly code: ProviderErrorCode;
  /** HTTP status dari provider. Ada = request ditolak SEBELUM stream dimulai. */
  readonly status?: number;
  readonly retryable: boolean;
  /**
   * Token yang SUDAH dilaporkan provider sebelum error dilempar (mis.
   * refusal atau output terpotong saat menyusun tool call — provider tetap
   * menagihnya). Ada = pakai angka ini, bukan estimasi.
   */
  readonly usage?: TokenUsage;

  constructor(opts: {
    provider: ProviderName;
    code: ProviderErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
    usage?: TokenUsage;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "ProviderError";
    this.provider = opts.provider;
    this.code = opts.code;
    this.status = opts.status;
    this.usage = opts.usage;
    this.retryable =
      opts.retryable ??
      (opts.code === "rate_limit" ||
        opts.code === "overloaded" ||
        opts.code === "network");
  }
}
