// Opsi cookie yang dipakai bersama oleh proxy.ts dan lib/server/session.ts.
// PURE (tanpa next/*), supaya kedua tempat itu tidak bisa beda setelan.

export type CookieOptions = {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
};

/**
 * - httpOnly: JavaScript di browser tidak bisa membaca cookie (mitigasi XSS
 *   mencuri session id / token auth).
 * - sameSite "lax": cookie tidak ikut di POST lintas situs → upload/chat dari
 *   situs lain (CSRF) tidak membawa sesi user.
 * - secure hanya di production: `next dev` berjalan di http://localhost.
 */
export function cookieOptions(maxAgeSec: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  };
}
