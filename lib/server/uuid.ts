// Helper UUID — PURE (tanpa next/*, tanpa server-only) supaya bisa dipakai
// proxy.ts, API route, dan unit test.

// Format kanonik 8-4-4-4-12 heksadesimal. Sengaja tidak mewajibkan versi 4:
// yang penting nilainya bisa diterima kolom `uuid` Postgres apa adanya.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** true kalau `s` adalah UUID kanonik (huruf besar/kecil diterima). */
export function isValidUuid(s: string): boolean {
  return UUID_RE.test(s);
}
