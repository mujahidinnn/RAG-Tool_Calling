// Konstanta aplikasi. Aman diimpor dari client maupun server: TIDAK ada secret
// di file ini. Secret & env hanya dibaca di lib/env.ts (server-only).

// --- Upload ---------------------------------------------------------------
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file
export const MAX_FILES_PER_SESSION = 5;
export const ALLOWED_EXTENSIONS = [".pdf", ".md", ".txt"] as const;
export type AllowedMimeType = "application/pdf" | "text/markdown" | "text/plain";
export const STORAGE_BUCKET = "documents";
/** Hasil ekstraksi di bawah ini dianggap "nyaris kosong" (mis. PDF hasil scan). */
export const MIN_EXTRACTED_CHARS = 20;
/** Dokumen + chunk lebih tua dari ini dihapus otomatis. */
export const DOCUMENT_TTL_HOURS = 24;
/**
 * Batas 5 MB TIDAK membatasi isi: PDF 300 KB terkompresi bisa berisi puluhan
 * juta karakter, dan .txt 5 MB berisi angka pendek = jutaan token. Tanpa batas
 * isi, 1 upload bisa melewati maxDuration, menyedot embedding, membekukan
 * event loop (tokenizer sinkron), dan memenuhi database.
 * - MAX_EXTRACTED_CHARS: ekstraksi berhenti di sini (pengaman memori/waktu).
 * - MAX_DOCUMENT_TOKENS: ±150 ribu token ≈ 200 halaman teks padat ≈ 330 chunk
 *   (±2,8 MB baris pgvector, ±2 putaran embedding).
 */
export const MAX_EXTRACTED_CHARS = 2_000_000;
export const MAX_DOCUMENT_TOKENS = 150_000;
/**
 * Batas dokumen tersimpan di SELURUH server (semua sesi). Sesi baru mudah
 * dibuat, jadi batas per sesi saja tidak melindungi kuota database (free tier
 * Supabase 500 MB): 100 × dokumen terbesar ≈ 280 MB. Dokumen lama terhapus
 * otomatis setelah DOCUMENT_TTL_HOURS.
 */
export const MAX_TOTAL_DOCUMENTS = 100;

// --- RAG ------------------------------------------------------------------
export const CHUNK_TOKENS = 500;
export const CHUNK_OVERLAP_TOKENS = 50;
export const TOP_K = 5;
/** Harus sama dengan `vector(N)` di lib/supabase/schema.sql. */
export const EMBEDDING_DIMENSIONS = 1536;
/** Batas token chunk yang dikirim ke LLM untuk tool get_document_summary. */
export const SUMMARY_MAX_INPUT_TOKENS = 12_000;

// --- Chat -----------------------------------------------------------------
/**
 * Model chat per provider. Sengaja di kode (bukan env) supaya selalu sinkron
 * dengan map harga di lib/llm/pricing.ts — model tanpa harga = biaya tak terhitung.
 */
export const CHAT_MODELS = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-5.6-terra",
} as const;
export const PROVIDER_LABELS = { anthropic: "Claude", openai: "GPT" } as const;
export const MAX_OUTPUT_TOKENS = 4096;
/** Maks putaran tool-call per pertanyaan (mencegah loop tak berujung). */
export const MAX_TOOL_ROUNDS = 3;
/** Jumlah pesan riwayat (user+assistant) yang dikirim ke LLM. */
export const MAX_HISTORY_MESSAGES = 6;
export const MAX_QUESTION_CHARS = 2000;
export const MAX_HISTORY_MESSAGE_CHARS = 4000;

// --- Proteksi demo publik ---------------------------------------------------
export const CHAT_RATE_LIMIT = { max: 20, windowMs: 60_000 } as const;
export const PASSCODE_RATE_LIMIT = { max: 5, windowMs: 60_000 } as const;
export const DEFAULT_DAILY_BUDGET_USD = 2;

// --- Cookie -----------------------------------------------------------------
export const SESSION_COOKIE = "sid";
export const AUTH_COOKIE = "demo_auth";
export const SESSION_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 hari
