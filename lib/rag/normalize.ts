// Normalisasi teks hasil ekstraksi (langkah di antara extract → chunk).
// MURNI supaya bisa di-unit-test (tests/normalize.test.ts).

/**
 * Rapikan teks hasil ekstraksi sebelum di-chunk & disimpan.
 * - `toWellFormed()`: surrogate "yatim" (bisa muncul dari PDF rusak) → "�".
 *   Tanpa ini insert ke Postgres lewat JSON bisa gagal.
 * - PDF: normalisasi NFKC memecah ligatur ("ﬁle" → "file") yang sering muncul
 *   dari font PDF dan merusak pencarian. File teks cukup NFC (aman, tidak
 *   mengubah makna seperti NFKC mengubah "m²" → "m2").
 * - Buang karakter kontrol (NUL ditolak kolom text Postgres), CRLF → LF,
 *   spasi di akhir baris, maks 1 baris kosong berturut-turut, trim.
 */
export function normalizeExtractedText(raw: string, opts: { pdf?: boolean } = {}): string {
  const text = raw.toWellFormed().normalize(opts.pdf ? "NFKC" : "NFC");
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\f\v]/g, "\n")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Apakah teks punya cukup karakter "terbaca" (huruf/angka)? Dipakai untuk
 * mendeteksi PDF hasil scan: ekstraksinya kosong atau cuma sisa simbol/"�"
 * dari font rusak — panjang string saja tidak cukup jadi ukuran.
 */
export function hasEnoughReadableText(text: string, minChars: number): boolean {
  const readable = /[\p{L}\p{N}]/gu;
  let count = 0;
  while (readable.exec(text) !== null) {
    count++;
    if (count >= minChars) return true; // berhenti cepat, tidak perlu scan 5 MB
  }
  return minChars <= 0;
}
