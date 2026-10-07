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

/** Huruf/angka minimal per halaman PDF supaya tidak dianggap hasil scan. */
export const MIN_READABLE_CHARS_PER_PDF_PAGE = 25;

/** Baris yang hanya berisi angka/tanda baca/simbol: nomor halaman, stempel Bates "000123", garis. */
const NON_TEXT_LINE = /^[\p{N}\p{P}\p{S}\s]*$/u;

/**
 * Jumlah huruf/angka "bermakna" di teks PDF, TANPA:
 * - baris yang hanya nomor/tanda baca (nomor halaman, stempel),
 * - baris yang berulang di banyak halaman (watermark "Scanned with
 *   CamScanner", header/footer berjalan).
 * PDF hasil scan sering tetap punya lapisan teks berisi hal-hal itu saja.
 * Hanya untuk keputusan "ada teks terbaca?" — teks yang di-chunk tidak diubah.
 */
export function countMeaningfulPdfChars(text: string, pageCount: number): number {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "" && !NON_TEXT_LINE.test(line));

  const occurrences = new Map<string, number>();
  for (const line of lines) {
    const key = line.toLowerCase();
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  // "Berulang" = muncul di ≥ separuh halaman (minimal 2x); PDF 1 halaman tidak dicek.
  const repeatedAt = Math.max(2, Math.ceil(pageCount / 2));

  let count = 0;
  for (const line of lines) {
    if (pageCount >= 2 && (occurrences.get(line.toLowerCase()) ?? 0) >= repeatedAt) continue;
    count += line.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  }
  return count;
}

/**
 * Cek "ada teks terbaca?" untuk PDF, RELATIF terhadap jumlah halaman: 239
 * huruf dari watermark di 10 halaman scan bukan dokumen yang bisa ditanya.
 * Ambang per halaman sengaja rendah supaya slide deck yang jarang teksnya lolos.
 */
export function hasEnoughReadablePdfText(text: string, pageCount: number, minChars: number): boolean {
  const needed = Math.max(minChars, MIN_READABLE_CHARS_PER_PDF_PAGE * Math.max(1, pageCount));
  return countMeaningfulPdfChars(text, pageCount) >= needed;
}
