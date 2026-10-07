import "server-only";

// Satu-satunya tempat membaca secret dari environment. `server-only` membuat
// build GAGAL kalau file ini (atau modul yang mengimpornya) ikut ke bundle
// client — jadi service role key & API key tidak mungkin bocor ke browser.

import { DEFAULT_DAILY_BUDGET_USD } from "@/lib/config";
import { EMBEDDING_PRICING } from "@/lib/llm/pricing";
import type { ProviderName } from "@/lib/llm/types";

export type ServerEnv = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  demoPasscode: string;
  defaultProvider: ProviderName;
  /** Embedding sengaja 1 provider saja (spec §0) — dimensi vector harus tetap. */
  embeddingProvider: "openai";
  embeddingModel: string;
  dailyBudgetUsd: number;
  /** Opsional: adapter melempar ProviderError "missing_key" saat dipakai. */
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
};

/** Env server tidak lengkap / tidak valid. Pesannya aman ditampilkan (tanpa nilai secret). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type EnvSource = Record<string, string | undefined>;

// String kosong / spasi dianggap tidak di-set (sering terjadi: `KEY=` di .env).
function read(source: EnvSource, name: string): string | null {
  const value = source[name]?.trim();
  return value ? value : null;
}

/**
 * Parse & validasi env. Dipisah dari getServerEnv() supaya bisa dipanggil
 * dengan objek env lain (mis. saat eksperimen). Semua masalah dikumpulkan
 * lalu dilempar sekaligus — lebih enak daripada memperbaiki satu per satu.
 */
export function parseServerEnv(source: EnvSource): ServerEnv {
  const problems: string[] = [];

  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DEMO_PASSCODE"] as const;
  const missing = required.filter((name) => read(source, name) === null);
  if (missing.length > 0) {
    problems.push(`belum di-set: ${missing.join(", ")}`);
  }

  const supabaseUrl = read(source, "SUPABASE_URL") ?? "";
  if (supabaseUrl && !/^https?:\/\/\S+$/i.test(supabaseUrl)) {
    problems.push("SUPABASE_URL harus berupa URL http(s), mis. https://xxxx.supabase.co");
  }

  const defaultProviderRaw = read(source, "DEFAULT_LLM_PROVIDER") ?? "anthropic";
  if (defaultProviderRaw !== "anthropic" && defaultProviderRaw !== "openai") {
    problems.push(`DEFAULT_LLM_PROVIDER harus "anthropic" atau "openai" (sekarang: "${defaultProviderRaw}")`);
  }

  const embeddingProviderRaw = read(source, "EMBEDDING_PROVIDER") ?? "openai";
  if (embeddingProviderRaw !== "openai") {
    problems.push(
      `EMBEDDING_PROVIDER hanya mendukung "openai" (sekarang: "${embeddingProviderRaw}") — ` +
        "embedding sengaja 1 provider supaya dimensi vector di pgvector tetap",
    );
  }

  // Model tanpa harga di pricing.ts = biaya embedding tidak bisa dihitung →
  // embeddingCostUsd() baru melempar SETELAH API dipanggil (sudah bayar) dan
  // user cuma melihat error generik. Lebih baik gagal di awal dengan pesan jelas.
  const embeddingModel = read(source, "EMBEDDING_MODEL") ?? "text-embedding-3-small";
  if (!Object.hasOwn(EMBEDDING_PRICING, embeddingModel)) {
    problems.push(
      `EMBEDDING_MODEL "${embeddingModel}" belum ada di lib/llm/pricing.ts ` +
        `(didukung: ${Object.keys(EMBEDDING_PRICING).join(", ")})`,
    );
  }

  const budgetRaw = read(source, "DAILY_BUDGET_USD");
  const dailyBudgetUsd = budgetRaw === null ? DEFAULT_DAILY_BUDGET_USD : Number(budgetRaw);
  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0) {
    problems.push(`DAILY_BUDGET_USD harus angka >= 0, mis. 2 atau 0.01 (sekarang: "${budgetRaw}")`);
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `Konfigurasi server belum lengkap — ${problems.join("; ")}. ` +
        "Salin .env.example ke .env.local, isi nilainya, lalu restart server.",
    );
  }

  return {
    supabaseUrl,
    supabaseServiceRoleKey: read(source, "SUPABASE_SERVICE_ROLE_KEY") ?? "",
    demoPasscode: read(source, "DEMO_PASSCODE") ?? "",
    defaultProvider: defaultProviderRaw === "openai" ? "openai" : "anthropic",
    embeddingProvider: "openai",
    embeddingModel,
    dailyBudgetUsd,
    anthropicApiKey: read(source, "ANTHROPIC_API_KEY"),
    openaiApiKey: read(source, "OPENAI_API_KEY"),
  };
}

let cached: ServerEnv | null = null;

/**
 * Env server, dibaca lazy saat pertama dipakai (bukan saat import) supaya
 * `next build` tidak gagal hanya karena env belum di-set di mesin build.
 * Hasil yang valid di-cache; yang gagal tidak, jadi error-nya selalu terlihat.
 */
export function getServerEnv(): ServerEnv {
  if (cached === null) {
    cached = parseServerEnv(process.env);
    // Rate limit passcode hanya memperlambat tebakan; passcode pendek tetap
    // bisa ditebak. Peringatan saja (bukan error) supaya demo lokal tetap jalan.
    if (cached.demoPasscode.length < 12) {
      console.warn("[env] DEMO_PASSCODE kurang dari 12 karakter — mudah ditebak di demo publik.");
    }
  }
  return cached;
}

/** Apakah API key provider chat ini sudah di-set (untuk dropdown UI). */
export function isProviderConfigured(name: ProviderName): boolean {
  const env = getServerEnv();
  return name === "anthropic" ? env.anthropicApiKey !== null : env.openaiApiKey !== null;
}
