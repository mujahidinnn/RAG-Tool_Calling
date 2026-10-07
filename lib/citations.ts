// Parsing sitasi `[nama_file, chunk #n]` dari jawaban LLM (spec §3.7 & §6).
//
// File ini PURE (tanpa React/DOM) supaya bisa dites (tests/citations.test.ts)
// dan dipakai di client.
//
// Kenapa parsing di client, bukan minta model mengembalikan JSON sitasi?
// Jawaban di-stream token demi token sebagai teks biasa; sitasi inline di
// teks adalah format yang paling natural bagi model dan tetap terbaca kalau
// UI gagal mem-parse. UI cukup "mengangkat" marker itu jadi chip yang bisa diklik.

import type { Source } from "@/lib/types";

export type Citation = {
  filename: string;
  chunkIndex: number;
  /** Teks marker utuh di jawaban, mis. "[panduan.pdf, chunk #3]". */
  raw: string;
  /** Posisi marker (bracket pembuka s/d setelah bracket penutup) di teks. */
  start: number;
  end: number;
};

// Isi bracket: tanpa "[", "]", atau baris baru, maksimal 400 karakter
// (mencegah regex menelan paragraf panjang saat model lupa menutup bracket).
const BRACKET_PATTERN = /\[([^[\]\n]{1,400})\]/g;

// `(.+)` sengaja greedy → memisah di KOMA TERAKHIR sebelum "chunk", jadi nama
// file yang mengandung koma ("laporan, final.pdf") tetap utuh.
// Toleran terhadap variasi model: "Chunk #3", "chunk#3", "chunk # 3", "chunk 3".
const PART_PATTERN = /^(.+),\s*chunk\s*#?\s*(\d{1,6})\s*$/i;

// Pembungkus yang kadang ditambahkan model di sekitar nama file (kutip, `code`, **tebal**).
const WRAPPER_CHARS = /^[\s"'`*_“”‘’]+|[\s"'`*_“”‘’]+$/g;

function parsePart(part: string): { filename: string; chunkIndex: number } | null {
  const match = PART_PATTERN.exec(part.trim());
  if (!match) return null;
  const filename = match[1].replace(WRAPPER_CHARS, "");
  if (filename.length === 0) return null;
  return { filename, chunkIndex: Number(match[2]) };
}

/**
 * Cari semua marker sitasi di teks, urut sesuai kemunculan.
 *
 * Satu bracket biasanya = 1 sitasi. Kalau model menggabungkan beberapa dengan
 * titik koma (`[a.pdf, chunk #1; b.md, chunk #4]`), tiap bagian jadi 1 entri
 * dengan `raw/start/end` yang sama (bracket-nya).
 */
export function parseCitations(text: string): Citation[] {
  const citations: Citation[] = [];
  for (const match of text.matchAll(BRACKET_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    // `[teks](url)` adalah link Markdown biasa, bukan sitasi.
    if (text[end] === "(") continue;

    const inner = match[1];
    // Coba versi gabungan (pakai ";") dulu: kalau langsung diparse sebagai 1
    // sitasi, regex greedy akan menelan "a.pdf, chunk #1; b.md" sebagai nama file.
    const parts = inner.includes(";") ? inner.split(";").map(parsePart) : [];
    const grouped = parts.length > 1 && parts.every((part) => part !== null) ? parts : null;
    const parsed = grouped ?? [parsePart(inner)];

    for (const item of parsed) {
      if (item) citations.push({ ...item, raw: match[0], start, end });
    }
  }
  return citations;
}

export function citationKey(citation: { filename: string; chunkIndex: number }): string {
  return `${citation.filename}\u0000${citation.chunkIndex}`;
}

/** Sitasi unik (file + chunk), urut kemunculan pertama — untuk chip di bawah pesan. */
export function uniqueCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const unique: Citation[] = [];
  for (const citation of citations) {
    const key = citationKey(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(citation);
  }
  return unique;
}

/** Prefix href yang dipakai linkifyCitations; dibaca balik oleh komponen `a` di UI. */
export const CITATION_HREF_PREFIX = "#cite-";

/**
 * Ganti tiap marker sitasi dengan link Markdown `[i](#cite-i)` — `i` = indeks
 * entri di hasil `parseCitations(text)` untuk teks yang SAMA. Komponen `a`
 * kustom di react-markdown lalu merender link ini sebagai CitationBadge inline.
 *
 * Kenapa indeks, bukan nama file di href? Nama file bisa berisi spasi, kurung,
 * atau karakter Markdown yang merusak sintaks link; angka selalu aman.
 */
export function linkifyCitations(text: string): string {
  const citations = parseCitations(text);
  if (citations.length === 0) return text;

  let output = "";
  let cursor = 0;
  citations.forEach((citation, index) => {
    // Entri dari bracket gabungan berbagi `start` — teks sebelum bracket
    // hanya disalin sekali, lalu link-nya dijejerkan.
    if (citation.start >= cursor) {
      output = escapeTrailingBang(output + text.slice(cursor, citation.start));
      cursor = citation.end;
    }
    output += `[${index}](${CITATION_HREF_PREFIX}${index})`;
  });
  return output + text.slice(cursor);
}

/**
 * "!" tepat sebelum link mengubahnya jadi sintaks GAMBAR Markdown
 * (`Penting![0](#cite-0)` → gambar, bukan badge sitasi). Escape "!" itu —
 * kecuali sudah di-escape (jumlah backslash di depannya ganjil).
 */
function escapeTrailingBang(text: string): string {
  if (!text.endsWith("!")) return text;
  let backslashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0 ? `${text.slice(0, -1)}\\!` : text;
}

/** Kebalikan dari linkifyCitations: "#cite-3" → 3, selain itu null. */
export function citationIndexFromHref(href: string | undefined): number | null {
  if (!href || !href.startsWith(CITATION_HREF_PREFIX)) return null;
  const value = href.slice(CITATION_HREF_PREFIX.length);
  return /^\d{1,6}$/.test(value) ? Number(value) : null;
}

// Nama file di context dikirim ke model dengan escaping atribut (&quot; dst.,
// lihat formatContext di lib/rag/prompt.ts) — model kadang menyalinnya apa adanya.
function normalizeFilename(name: string): string {
  return name
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .normalize("NFC")
    .trim()
    .toLowerCase();
}

/**
 * Cocokkan sitasi dengan chunk yang BENAR-BENAR diambil untuk jawaban ini.
 * Tidak ketemu = model menyebut sumber yang tidak ada di context → UI
 * menandainya "tidak terverifikasi" (indikator halusinasi sitasi).
 */
export function findSource(
  citation: { filename: string; chunkIndex: number },
  sources: readonly Source[],
): Source | undefined {
  const exact = sources.find(
    (source) => source.filename === citation.filename && source.chunkIndex === citation.chunkIndex,
  );
  if (exact) return exact;
  const wanted = normalizeFilename(citation.filename);
  return sources.find(
    (source) =>
      source.chunkIndex === citation.chunkIndex && normalizeFilename(source.filename) === wanted,
  );
}
