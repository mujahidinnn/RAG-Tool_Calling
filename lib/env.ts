import "server-only";

// Satu-satunya tempat membaca secret dari environment. `server-only` membuat
// build GAGAL kalau file ini (atau modul yang mengimpornya) ikut ke bundle
// client — jadi service role key & API key tidak mungkin bocor ke browser.

import { CHAT_MODELS, DEFAULT_DAILY_BUDGET_USD, PROVIDER_LABELS } from "@/lib/config";
import { EMBEDDING_PRICING, formatUsd } from "@/lib/llm/pricing";
import { initialChatReserveUsd } from "@/lib/server/budget";
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
  /**
   * Jumlah reverse proxy tepercaya yang MENAMBAHKAN IP klien ke
   * X-Forwarded-For (lihat lib/server/client-ip.ts). Default 0 = header IP
   * tidak dipercaya (kecuali di Vercel).
   */
  trustedProxyHops: number;
  /** true kalau berjalan di Vercel (env VERCEL diisi otomatis oleh platform). */
  onVercel: boolean;
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

  const hopsRaw = read(source, "TRUSTED_PROXY_HOPS");
  const trustedProxyHops = hopsRaw === null ? 0 : Number(hopsRaw);
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) {
    problems.push(`TRUSTED_PROXY_HOPS harus bilangan bulat 0–5 (sekarang: "${hopsRaw}")`);
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
    trustedProxyHops,
    onVercel: read(source, "VERCEL") !== null,
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
    // Rate limit passcode hanya memperlambat tebakan, dan tanpa IP tepercaya
    // tidak bisa membedakan penebak (plafon global sengaja tinggi) — panjang
    // passcode-lah pertahanan sebenarnya. Peringatan saja (bukan error) supaya
    // demo lokal tetap jalan; nilainya TIDAK pernah ditulis ke log.
    warnOncePerProcess(() => {
      if (cached === null) return;
      if (cached.demoPasscode.length < 12) {
        console.warn(
          "[env] DEMO_PASSCODE kurang dari 12 karakter — mudah ditebak di demo publik. " +
            "Rate limit hanya memperlambat tebakan; pakai ≥12 karakter acak.",
        );
      }
      warnIfBudgetTooSmall(cached.dailyBudgetUsd);
    });
  }
  return cached;
}

/**
 * instrumentation.ts dan route handler dibundel terpisah oleh Next, jadi
 * variabel modul `cached` di atas ada 2 salinan. Penanda di globalThis
 * memastikan peringatan config tercetak 1x per proses, bukan 1x per bundel.
 */
const WARNED_KEY = Symbol.for("ai-docs-assistant.env-warned");
function warnOncePerProcess(warn: () => void): void {
  const store = globalThis as Record<symbol, unknown>;
  if (store[WARNED_KEY]) return;
  store[WARNED_KEY] = true;
  warn();
}

/**
 * Setiap pertanyaan chat memesan dulu biaya maksimal ronde pertamanya
 * (lib/server/budget.ts). Budget di bawah angka itu menolak SEMUA pertanyaan
 * dengan pesan "limit harian" walau pemakaian hari ini $0 — bukan error
 * (tes "budget kecil" di spec §10 memang memakai ini), tapi perlu diketahui operator.
 */
function warnIfBudgetTooSmall(dailyBudgetUsd: number): void {
  // Reservasi minimal beda per model (harga beda), jadi cek per provider.
  const tooSmall = (Object.keys(CHAT_MODELS) as ProviderName[])
    .map((name) => ({
      label: PROVIDER_LABELS[name],
      minimum: initialChatReserveUsd({ model: CHAT_MODELS[name], question: "", history: [], tools: [] }),
    }))
    .filter(({ minimum }) => dailyBudgetUsd < minimum);
  if (tooSmall.length === 0) return;
  const who =
    tooSmall.length === Object.keys(CHAT_MODELS).length
      ? "semua pertanyaan chat"
      : `pertanyaan ke ${tooSmall.map(({ label }) => label).join(" & ")}`;
  const detail = tooSmall.map(({ label, minimum }) => `${label} ±${formatUsd(minimum)}`).join(", ");
  console.warn(
    `[env] DAILY_BUDGET_USD (${formatUsd(dailyBudgetUsd)}) lebih kecil dari reservasi minimal 1 pertanyaan ` +
      `(${detail}) — ${who} akan ditolak dengan pesan limit harian.`,
  );
}

/** Apakah API key provider chat ini sudah di-set (untuk dropdown UI). */
export function isProviderConfigured(name: ProviderName): boolean {
  const env = getServerEnv();
  return name === "anthropic" ? env.anthropicApiKey !== null : env.openaiApiKey !== null;
}
