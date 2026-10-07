import "server-only";

// Daily budget GLOBAL (semua sesi digabung) untuk demo publik (spec §2).
//
// Aturan utama: cek-dan-tambah dilakukan di SQL dalam 1 statement atomic
// (fungsi try_reserve_usage / record_usage di schema.sql). JANGAN pernah
// "baca cost_usd → bandingkan di JS → tulis balik": 2 request bersamaan bisa
// sama-sama lolos cek sebelum salah satu sempat menulis.
//
// Alur (biaya baru diketahui setelah LLM/embedding selesai):
//   1. reserveBudget(biaya maksimal) → pesan "jatah" dulu; ditolak kalau melebihi budget
//      (chat memesan lagi sebelum tiap panggilan LLM tambahan — lib/server/budget.ts)
//   2. ...panggil LLM / embedding...
//   3. settleUsage(reservasi, aktual) → koreksi: catat token & selisih biaya
// recordUsage(aktual) hanya untuk biaya yang sudah terjadi tanpa reservasi.

import { z } from "zod";
import { getServerEnv } from "@/lib/env";
import { getSupabase } from "@/lib/supabase/client";

export { DAILY_LIMIT_MESSAGE } from "./budget";

export type Reservation = {
  /** Tanggal (UTC, YYYY-MM-DD) baris usage_daily yang dipesan. */
  day: string;
  reservedUsd: number;
};

export type UsageActual = { tokens: number; costUsd: number };

export type UsageToday = { day: string; tokensUsed: number; costUsd: number };

// PostgREST mengirim numeric/bigint sebagai number, tapi coerce supaya tetap
// benar kalau suatu saat dikirim sebagai string.
const usageTodaySchema = z.object({
  day: z.string(),
  tokens_used: z.coerce.number(),
  cost_usd: z.coerce.number(),
});

// Bulatkan ke 1e-8 USD supaya angka di DB rapi (0.1 + 0.2 = 0.30000000000000004).
function roundUsd(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/** Pemakaian hari ini menurut database (definisi "hari ini" = UTC, sama dengan SQL). */
export async function getUsageToday(): Promise<UsageToday> {
  const { data, error } = await getSupabase().rpc("get_usage_today").single();
  if (error) throw new Error(`Gagal membaca pemakaian harian: ${error.message}`);
  const row = usageTodaySchema.parse(data);
  return { day: row.day, tokensUsed: row.tokens_used, costUsd: row.cost_usd };
}

/**
 * Pesan jatah biaya sebelum memanggil LLM. Gagal koneksi DB → THROW (fail
 * closed): lebih baik demo menolak request daripada budget tidak terjaga.
 */
export async function reserveBudget(
  estimatedCostUsd: number,
): Promise<
  | { ok: true; reservation: Reservation }
  | { ok: false; spentUsd: number; budgetUsd: number }
> {
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
    throw new Error(`reserveBudget: estimasi biaya tidak valid (${estimatedCostUsd})`);
  }
  const budgetUsd = getServerEnv().dailyBudgetUsd;
  const reservedUsd = roundUsd(estimatedCostUsd);

  const { data, error } = await getSupabase().rpc("try_reserve_usage", {
    p_cost: reservedUsd,
    p_budget: budgetUsd,
  });
  if (error) throw new Error(`Gagal memesan budget harian: ${error.message}`);

  // Fungsi SQL mengembalikan tanggal reservasi, atau NULL kalau melebihi budget.
  if (typeof data === "string" && data.length > 0) {
    return { ok: true, reservation: { day: data, reservedUsd } };
  }
  const today = await getUsageToday();
  return { ok: false, spentUsd: today.costUsd, budgetUsd };
}

function sanitizeActual(actual: UsageActual): { tokens: number; costUsd: number } | null {
  if (!Number.isFinite(actual.tokens) || !Number.isFinite(actual.costUsd)) return null;
  return { tokens: Math.max(0, Math.round(actual.tokens)), costUsd: Math.max(0, actual.costUsd) };
}

async function callRecordUsage(day: string | null, tokens: number, costDeltaUsd: number): Promise<void> {
  const { error } = await getSupabase().rpc("record_usage", {
    p_day: day,
    p_tokens: tokens,
    p_cost: roundUsd(costDeltaUsd),
  });
  if (error) throw new Error(error.message);
}

/**
 * Selesaikan reservasi (1 atau beberapa — chat memesan bertahap): catat
 * token aktual dan selisih biaya (aktual - total dipesan; biasanya negatif =
 * sisa jatah dikembalikan). Panggil TEPAT 1x per kumpulan reservasi.
 * Tidak pernah throw — dipanggil di `finally`; kegagalan dicatat.
 */
export async function settleUsage(
  reservations: Reservation | readonly Reservation[],
  actual: UsageActual,
): Promise<void> {
  const list: readonly Reservation[] = "day" in reservations ? [reservations] : reservations;
  const clean = sanitizeActual(actual);
  if (clean === null) {
    // Jangan refund kalau angka aktual rusak: jatah yang sudah dipesan tetap
    // terhitung (aman untuk budget), cukup dicatat di log.
    console.error("[usage] settleUsage: angka aktual tidak valid, reservasi dibiarkan", actual);
    return;
  }
  const firstDay = list[0]?.day ?? null;
  if (firstDay === null) {
    await recordUsage(clean);
    return;
  }

  // Dikelompokkan per tanggal reservasi (bukan "hari ini") supaya refund masuk
  // ke hari yang benar walau request melewati tengah malam UTC. Biaya aktual
  // dibukukan ke hari reservasi PERTAMA; hari lain hanya menerima refund.
  const reservedByDay = new Map<string, number>();
  for (const reservation of list) {
    reservedByDay.set(reservation.day, (reservedByDay.get(reservation.day) ?? 0) + reservation.reservedUsd);
  }
  for (const [day, reservedUsd] of reservedByDay) {
    const isFirst = day === firstDay;
    try {
      await callRecordUsage(day, isFirst ? clean.tokens : 0, (isFirst ? clean.costUsd : 0) - reservedUsd);
    } catch (err) {
      console.error("[usage] settleUsage gagal:", err instanceof Error ? err.message : err);
    }
  }
}

/** Catat pemakaian tanpa reservasi (mis. biaya embedding). Tidak pernah throw. */
export async function recordUsage(actual: UsageActual): Promise<void> {
  try {
    const clean = sanitizeActual(actual);
    if (clean === null) {
      console.error("[usage] recordUsage: angka tidak valid, dilewati", actual);
      return;
    }
    if (clean.tokens === 0 && clean.costUsd === 0) return;
    // p_day NULL = "hari ini" menurut database.
    await callRecordUsage(null, clean.tokens, clean.costUsd);
  } catch (err) {
    console.error("[usage] recordUsage gagal:", err instanceof Error ? err.message : err);
  }
}

/** true kalau biaya hari ini sudah >= budget. Gagal baca DB → throw (fail closed). */
export async function isBudgetExhausted(): Promise<boolean> {
  const today = await getUsageToday();
  return today.costUsd >= getServerEnv().dailyBudgetUsd;
}
