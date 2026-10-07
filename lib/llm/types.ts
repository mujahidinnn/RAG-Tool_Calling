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
  | { role: "user" | "assistant"; content: string }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** Hasil eksekusi tool dalam bentuk string (biasanya JSON). */
      content: string;
    };

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

/** 3 event generik hasil penyeragaman stream Anthropic & OpenAI. */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; inputTokens: number; outputTokens: number };

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
export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(opts: {
    provider: ProviderName;
    code: ProviderErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "ProviderError";
    this.provider = opts.provider;
    this.code = opts.code;
    this.status = opts.status;
    this.retryable =
      opts.retryable ??
      (opts.code === "rate_limit" ||
        opts.code === "overloaded" ||
        opts.code === "network");
  }
}
