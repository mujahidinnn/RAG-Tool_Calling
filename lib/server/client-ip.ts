// IP klien untuk rate limit. PURE (tanpa server-only / next / env) supaya
// aturan "header mana yang boleh dipercaya" bisa diuji (tests/client-ip.test.ts).
//
// Masalahnya: X-Forwarded-For (XFF) bisa diisi klien sendiri. `next start`
// hanya mengisi XFF kalau header itu BELUM ada (`??=`), jadi nilai palsu dari
// klien lolos apa adanya. Proxy yang "menambahkan" (nginx
// `$proxy_add_x_forwarded_for`, kebanyakan load balancer PaaS) menaruh IP
// yang ia lihat di UJUNG KANAN — entri di kirinya tetap buatan klien.
// Kalau entri paling kiri yang dipakai, penyerang cukup mengganti XFF di
// setiap request untuk mendapat "IP baru" (= kuota rate limit baru).

export type ProxyTrust = {
  /**
   * Jumlah proxy tepercaya di depan app yang MENAMBAHKAN IP ke XFF
   * (env TRUSTED_PROXY_HOPS). 0 = tidak ada / tidak diketahui → XFF tidak dipercaya.
   */
  trustedProxyHops: number;
  /** Berjalan di Vercel (env VERCEL=1): edge Vercel menimpa header IP, klien tidak bisa memalsukannya. */
  onVercel: boolean;
};

/** IP yang lebih panjang dari ini pasti bukan IP (IPv6 maks 45 karakter) — jangan jadi key memori. */
const MAX_IP_LENGTH = 64;

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_IP_LENGTH) return null;
  return trimmed;
}

function forwardedEntries(headers: Headers): string[] {
  return (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * IP klien yang bisa dipercaya, atau null kalau tidak ada sumber tepercaya.
 * null BUKAN error: pemanggil cukup melewati limiter per-IP dan mengandalkan
 * limiter lain (per sesi + global).
 */
export function clientIpFromHeaders(headers: Headers, trust: ProxyTrust): string | null {
  if (trust.onVercel) {
    // Di Vercel header-header ini diisi ulang oleh platform di setiap request.
    return (
      clean(headers.get("x-vercel-forwarded-for")?.split(",")[0]) ??
      clean(headers.get("x-real-ip")) ??
      clean(forwardedEntries(headers)[0])
    );
  }
  if (trust.trustedProxyHops > 0) {
    // Hitung dari KANAN: proxy tepercaya terdekat menambahkan entri terakhir,
    // jadi IP klien sebenarnya ada di posisi ke-N dari kanan.
    const entries = forwardedEntries(headers);
    const index = entries.length - trust.trustedProxyHops;
    return index >= 0 ? clean(entries[index]) : null;
  }
  // Self-host tanpa proxy tepercaya: XFF sepenuhnya dikontrol klien.
  return null;
}
