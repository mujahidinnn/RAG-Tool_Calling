import "server-only";

// Sesi demo + gerbang passcode, berbasis 2 cookie httpOnly:
// * SESSION_COOKIE (UUID acak) — SATU konsep, DUA pemakaian (spec §1):
//   scoping dokumen per sesi DAN key rate limit per sesi.
// * AUTH_COOKIE — bukti "sudah memasukkan passcode yang benar".
// Ini bukan auth penuh (non-goal spec §7): tidak ada akun/user.

import { cookies } from "next/headers";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AUTH_COOKIE, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_SEC } from "@/lib/config";
import { getServerEnv } from "@/lib/env";
import { cookieOptions } from "@/lib/server/cookieOptions";
import { jsonError } from "@/lib/server/http";
import { isValidUuid } from "@/lib/server/uuid";

export { isValidUuid };

const AUTH_TOKEN_CONTEXT = "ai-docs-assistant:auth:v1";

/**
 * Session id dari cookie; kalau belum ada / tidak valid, buat baru dan set
 * cookie-nya. WAJIB dipanggil sebelum respons streaming dimulai: cookie hanya
 * bisa dikirim lewat header, dan header terkirim saat streaming mulai.
 *
 * Normalnya cookie sudah dibuat proxy.ts saat halaman pertama dibuka, jadi
 * request API paralel pertama tidak saling membuat sesi berbeda.
 */
export async function getOrCreateSessionId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(SESSION_COOKIE)?.value;
  // Nilai cookie dikontrol klien → validasi format sebelum dipakai di query.
  // Lowercase supaya "ABC…" dan "abc…" tidak jadi 2 key rate limit berbeda.
  if (existing && isValidUuid(existing)) return existing.toLowerCase();

  const id = randomUUID();
  store.set(SESSION_COOKIE, id, cookieOptions(SESSION_COOKIE_MAX_AGE_SEC));
  return id;
}

/**
 * Token yang disimpan di AUTH_COOKIE: HMAC dari passcode, bukan passcode-nya
 * (cookie bocor ≠ passcode bocor). Ganti DEMO_PASSCODE = semua cookie lama
 * otomatis tidak berlaku.
 */
export function authToken(passcode: string): string {
  return createHmac("sha256", passcode).update(AUTH_TOKEN_CONTEXT).digest("hex");
}

// Bandingkan hash SHA-256 (panjang selalu 32 byte) dengan timingSafeEqual:
// perbandingan string biasa (`===`) berhenti di karakter pertama yang beda,
// sehingga waktu respons bisa membocorkan berapa karakter yang sudah benar.
// Hashing dulu juga menyembunyikan panjang passcode.
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Cek passcode input terhadap DEMO_PASSCODE (timing-safe). */
export function verifyPasscode(input: string): boolean {
  return safeEqual(input, getServerEnv().demoPasscode);
}

/** Apakah request ini membawa AUTH_COOKIE yang valid. */
export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  if (!token) return false;
  return safeEqual(token, authToken(getServerEnv().demoPasscode));
}

export async function setAuthCookie(): Promise<void> {
  const store = await cookies();
  store.set(AUTH_COOKIE, authToken(getServerEnv().demoPasscode), cookieOptions(SESSION_COOKIE_MAX_AGE_SEC));
}

export async function clearAuthCookie(): Promise<void> {
  const store = await cookies();
  // Set ulang dengan maxAge 0 (atribut path dll sama) supaya browser menghapusnya.
  store.set(AUTH_COOKIE, "", cookieOptions(0));
}

/**
 * Guard di awal SETIAP API route (kecuali /api/auth): pastikan cookie sesi
 * ada, lalu tolak 401 kalau belum memasukkan passcode.
 */
export async function requireSession(): Promise<
  { ok: true; sessionId: string } | { ok: false; response: Response }
> {
  const sessionId = await getOrCreateSessionId();
  if (!(await isAuthenticated())) {
    return {
      ok: false,
      response: jsonError(401, "unauthorized", "Masukkan passcode demo dulu."),
    };
  }
  return { ok: true, sessionId };
}
