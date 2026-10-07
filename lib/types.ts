// Tipe yang dipakai bersama oleh API route (server) dan UI (client).
// Jangan impor modul server-only di sini.

import type { ProviderName } from "@/lib/llm/types";

export type { ProviderName };

// --- Dokumen ------------------------------------------------------------------
export type DocumentStatus = "processing" | "ready" | "failed";

/** Bentuk dokumen yang dikirim ke client (camelCase, tanpa session_id / storage_path). */
export type DocumentDTO = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  errorMessage: string | null;
  createdAt: string;
  /** Jumlah chunk tersimpan (0 selama processing / failed). */
  chunkCount: number;
};

// --- Error API ------------------------------------------------------------------
export type ApiErrorCode =
  | "unauthorized" // belum memasukkan passcode
  | "invalid_passcode"
  | "too_many_attempts" // brute-force passcode
  | "rate_limited" // > 20 request/menit per sesi
  | "daily_limit" // budget harian global habis
  | "file_too_large"
  | "unsupported_type"
  | "too_many_files"
  | "empty_file"
  | "not_found"
  | "bad_request"
  | "provider_error" // error dari Anthropic/OpenAI (lihat field provider)
  | "config_error" // env server belum lengkap
  | "internal";

/** Bentuk body JSON untuk semua respons error API. */
export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string; // pesan siap tampil ke user (Bahasa Indonesia)
    retryable?: boolean;
    retryAfterSec?: number;
    provider?: ProviderName;
  };
};

// --- GET /api/auth ----------------------------------------------------------------
export type ProviderInfo = {
  name: ProviderName;
  label: string; // "Claude" | "GPT"
  model: string;
  /** false kalau API key provider belum di-set di server. */
  configured: boolean;
};

export type AuthStatusResponse = {
  authenticated: boolean;
  defaultProvider: ProviderName;
  providers: ProviderInfo[];
  limits: {
    maxFileBytes: number;
    maxFilesPerSession: number;
    allowedExtensions: string[];
    documentTtlHours: number;
  };
};

// --- /api/documents ----------------------------------------------------------------
export type DocumentsResponse = { documents: DocumentDTO[] };

// --- /api/chat -------------------------------------------------------------------------
export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

export type ChatRequestBody = {
  provider: ProviderName;
  question: string;
  /** Riwayat percakapan sebelumnya (teks saja), urut lama → baru. */
  history: ChatHistoryMessage[];
};

/** Chunk hasil retrieval yang bisa dikutip model. */
export type Source = {
  id: string; // chunks.id
  documentId: string;
  filename: string;
  chunkIndex: number; // chunks.chunk_index — sama dengan angka di sitasi "chunk #n"
  content: string;
  similarity: number; // 0..1 (1 - cosine distance)
};

/** Data untuk card hasil tool di UI (tampil beda dari jawaban chat biasa). */
export type ToolCardPayload =
  | {
      kind: "documents";
      documents: Pick<
        DocumentDTO,
        "id" | "filename" | "status" | "sizeBytes" | "createdAt" | "errorMessage" | "chunkCount"
      >[];
    }
  | {
      kind: "summary";
      documentId: string;
      filename: string;
      summary: string;
      chunksUsed: number;
      totalChunks: number;
    }
  | { kind: "error"; message: string };

/**
 * Event Server-Sent Events dari POST /api/chat.
 * Format wire: `data: <JSON ChatStreamEvent>\n\n` (satu event per baris data).
 * Urutan normal: meta → sources → (text | tool_call | tool_result)* → usage → done.
 * Kalau gagal di tengah: ... → error → usage (biaya yang sudah terpakai) → done.
 */
export type ChatStreamEvent =
  | {
      type: "meta";
      provider: ProviderName;
      model: string;
      label: string;
      /** Query yang benar-benar di-embed (hasil rewrite kalau follow-up). */
      searchQuery: string;
      rewritten: boolean;
    }
  | { type: "sources"; sources: Source[] }
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; payload: ToolCardPayload }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | {
      type: "error";
      code: ApiErrorCode;
      message: string;
      retryable: boolean;
      provider?: ProviderName;
    }
  | { type: "done" };
