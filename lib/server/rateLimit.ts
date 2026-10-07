// Rate limiter in-memory, algoritma "sliding window log". PURE (diuji di
// tests/rateLimit.test.ts): tidak ada import next/*, server-only, atau env.
//
// Batasan yang disengaja (cukup untuk demo, sesuai spec §2):
// * Counter hidup di memori 1 instance server. Di serverless (Vercel), tiap
//   instance punya counter sendiri dan reset saat cold start — jadi ini rem
//   untuk penyalahgunaan ringan, BUKAN batas keras. Batas keras untuk biaya
//   adalah daily budget global yang atomic di database (lib/server/usage.ts).
// * Key berbasis session id dari cookie. Klien yang membuang cookie mendapat
//   sesi baru (= kuota baru). Karena itu ada juga limiter per IP (kalau IP-nya
//   bisa dipercaya, lihat lib/server/client-ip.ts) dan plafon GLOBAL untuk
//   passcode salah — key yang bisa diganti-ganti klien tidak boleh jadi
//   satu-satunya rem.

import {
  CHAT_RATE_LIMIT,
  PASSCODE_GLOBAL_FAILURE_LIMIT,
  PASSCODE_IP_RATE_LIMIT,
  PASSCODE_RATE_LIMIT,
} from "@/lib/config";

export type RateLimitResult = {
  allowed: boolean;
  /** Sisa request yang masih boleh di window ini (setelah request ini). */
  remaining: number;
  /** 0 kalau allowed; kalau ditolak, detik sampai 1 slot kosong lagi. */
  retryAfterSec: number;
};

export type RateLimiter = {
  /** Cek DAN catat 1 request (kalau diizinkan). */
  check(key: string, now?: number): RateLimitResult;
  /** Cek saja, TANPA mencatat — untuk limiter yang hanya menghitung kejadian tertentu (mis. passcode salah). */
  peek(key: string, now?: number): RateLimitResult;
  /** Jumlah key yang sedang dilacak (untuk test & observability). */
  size(): number;
};

export type RateLimiterOptions = {
  max: number;
  windowMs: number;
  /** Batas jumlah key di memori; default 10.000. */
  maxKeys?: number;
};

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { max, windowMs, maxKeys = 10_000 } = opts;
  if (!Number.isInteger(max) || max < 1) {
    throw new Error("createRateLimiter: max harus bilangan bulat >= 1");
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("createRateLimiter: windowMs harus > 0");
  }
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new Error("createRateLimiter: maxKeys harus bilangan bulat >= 1");
  }

  // key → timestamp (ms) request yang DITERIMA, urut lama → baru.
  // Map menjaga urutan insert; kita re-insert key tiap dipakai sehingga key
  // pertama di Map = yang paling lama tidak aktif (dipakai untuk eviction).
  const hits = new Map<string, number[]>();
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  // Buang key yang semua timestamp-nya sudah keluar window, supaya memori
  // tidak tumbuh terus oleh sesi yang sudah pergi.
  function sweep(now: number): void {
    const windowStart = now - windowMs;
    for (const [key, stamps] of hits) {
      const newest = stamps[stamps.length - 1];
      if (newest === undefined || newest <= windowStart) hits.delete(key);
    }
    lastSweepAt = now;
  }

  function evaluate(key: string, now: number, record: boolean): RateLimitResult {
    // Sweep paling sering 1x per window (bukan tiap request) supaya O(n)
    // ini tidak jalan terus; atau lebih cepat kalau memori sudah penuh.
    if (now - lastSweepAt >= windowMs || hits.size >= maxKeys) sweep(now);

    const windowStart = now - windowMs;
    const stamps = (hits.get(key) ?? []).filter((t) => t > windowStart);

    if (stamps.length >= max) {
      // Request yang DITOLAK tidak dicatat: kalau dicatat, klien yang terus
      // mencoba akan terkunci selamanya, bukan dibatasi `max` per window.
      hits.delete(key);
      hits.set(key, stamps);
      // Slot pertama kosong saat timestamp tertua keluar dari window.
      // Dibatasi [1, window] supaya tetap masuk akal walau jam sistem mundur.
      const oldest = stamps[0] ?? now;
      const retryMs = Math.min(Math.max(oldest + windowMs - now, 0), windowMs);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)),
      };
    }

    if (!record) {
      // peek: jangan membuat key baru di memori untuk key yang belum pernah tercatat.
      if (stamps.length > 0) {
        hits.delete(key);
        hits.set(key, stamps);
      }
      return { allowed: true, remaining: max - stamps.length, retryAfterSec: 0 };
    }

    stamps.push(now);
    hits.delete(key);
    hits.set(key, stamps);
    // Masih penuh setelah sweep → buang key yang paling lama tidak aktif.
    while (hits.size > maxKeys) {
      const oldestKey = hits.keys().next().value;
      if (oldestKey === undefined) break;
      hits.delete(oldestKey);
    }
    return { allowed: true, remaining: max - stamps.length, retryAfterSec: 0 };
  }

  return {
    check(key: string, now: number = Date.now()): RateLimitResult {
      return evaluate(key, now, true);
    },

    peek(key: string, now: number = Date.now()): RateLimitResult {
      return evaluate(key, now, false);
    },

    size(): number {
      return hits.size;
    },
  };
}

/** /api/chat: maks 20 request/menit per sesi (spec §2). */
export const chatRateLimiter = createRateLimiter(CHAT_RATE_LIMIT);

/** POST /api/auth: rem brute-force passcode, per sesi. */
export const passcodeRateLimiter = createRateLimiter(PASSCODE_RATE_LIMIT);

/**
 * POST /api/auth: rem UTAMA brute-force passcode — per IP, karena IP adalah
 * satu-satunya identitas penebak yang tidak bisa diganti gratis (limiter per
 * sesi diakali dengan membuang cookie). Hanya aktif kalau IP bisa dipercaya
 * (Vercel / TRUSTED_PROXY_HOPS). Lebih longgar dari per sesi karena 1 kelas
 * bisa berbagi 1 IP (NAT).
 */
export const passcodeIpRateLimiter = createRateLimiter(PASSCODE_IP_RATE_LIMIT);

/** Key tunggal untuk passcodeFailureLimiter (bukan per sesi / per IP). */
export const GLOBAL_KEY = "global";

/**
 * POST /api/auth: PLAFON global passcode SALAH dari semua klien sekaligus
 * (key tunggal GLOBAL_KEY). Sengaja tinggi: limiter tanpa identitas penebak
 * juga menahan user yang sah, jadi kalau rendah, siapa pun yang mengirim
 * tebakan pelan-pelan bisa mengunci login baru semua orang. Plafon ini hanya
 * untuk tebakan masif (botnet / IP tidak bisa dipercaya); pertahanan
 * sebenarnya di situ adalah passcode yang panjang & acak.
 */
export const passcodeFailureLimiter = createRateLimiter(PASSCODE_GLOBAL_FAILURE_LIMIT);

export type PasscodeLimiters = {
  perSession: RateLimiter;
  perIp: RateLimiter;
  globalFailures: RateLimiter;
};

export const passcodeLimiters: PasscodeLimiters = {
  perSession: passcodeRateLimiter,
  perIp: passcodeIpRateLimiter,
  globalFailures: passcodeFailureLimiter,
};

export type PasscodeAttemptBlock = {
  /** "global" = plafon semua klien; "client" = sesi / IP ini sendiri. */
  scope: "global" | "client";
  result: RateLimitResult;
};

/**
 * Cek 1 percobaan passcode di semua lapis rem. null = boleh lanjut cek
 * passcode; kalau salah, panggil recordPasscodeFailure().
 * - Per sesi: dicatat di sini (user sah cukup login 1x per sesi).
 * - Per IP & plafon global: hanya di-peek; yang dicatat hanya passcode SALAH.
 *   Kalau login BENAR ikut dihitung, 1 kelas >20 murid di belakang 1 IP NAT
 *   (lab sekolah) saling memblokir padahal tidak ada yang menebak.
 * Pemanggil WAJIB tidak await di antara fungsi ini dan recordPasscodeFailure():
 * request paralel yang menyelip di celah await bisa sama-sama lolos sebelum
 * ada yang tercatat.
 */
export function admitPasscodeAttempt(
  limiters: PasscodeLimiters,
  sessionId: string,
  ip: string | null,
  now: number = Date.now(),
): PasscodeAttemptBlock | null {
  // Global cuma di-peek (tidak mencatat) dan dicek duluan: selama plafon
  // penuh, percobaan user sah tidak ikut menghabiskan kuota sesi/IP-nya.
  const global = limiters.globalFailures.peek(GLOBAL_KEY, now);
  if (!global.allowed) return { scope: "global", result: global };

  const checks = [limiters.perSession.check(sessionId, now)];
  if (ip !== null) checks.push(limiters.perIp.peek(`ip:${ip}`, now));
  const blocked = checks.find((result) => !result.allowed);
  return blocked ? { scope: "client", result: blocked } : null;
}

/** Catat 1 passcode SALAH ke plafon global. */
export function recordPasscodeFailure(
  limiters: PasscodeLimiters,
  ip: string | null,
  now: number = Date.now(),
): void {
  limiters.globalFailures.check(GLOBAL_KEY, now);
  if (ip !== null) limiters.perIp.check(`ip:${ip}`, now);
}

/**
 * /api/chat & /api/upload per IP (hanya kalau IP bisa dipercaya): sesi baru
 * murah dibuat, jadi limit per sesi saja tidak cukup. Longgar karena 1 kelas
 * bisa berbagi 1 IP (NAT).
 */
export const chatIpRateLimiter = createRateLimiter({ max: 120, windowMs: 60_000 });
export const uploadIpRateLimiter = createRateLimiter({ max: 30, windowMs: 60_000 });
