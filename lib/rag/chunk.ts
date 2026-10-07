// Chunking berbasis token (spec §3.2): potong teks ±500 token per chunk dengan
// overlap 50 token, supaya kalimat di batas chunk tetap punya konteks.
//
// Modul ini MURNI (tanpa server-only / next / env) karena di-unit-test (spec §9).

// Pakai build "lite" + ranks cl100k_base saja: import default `js-tiktoken`
// ikut membawa SEMUA tokenizer (±7 MB JS). cl100k_base = tokenizer milik
// text-embedding-3-small, jadi hitungan token kita sama dengan hitungan OpenAI.
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

import { CHUNK_OVERLAP_TOKENS, CHUNK_TOKENS } from "@/lib/config";

export type TextChunk = {
  index: number;
  /** Potongan PERSIS dari teks asli (tidak di-trim), jadi overlap bisa dicek. */
  content: string;
  /** Jumlah token window ini (selalu ≤ chunkTokens). */
  tokenCount: number;
};

export type ChunkOptions = {
  chunkTokens?: number;
  overlapTokens?: number;
  /**
   * Batas total token dokumen. Lewat batas → DocumentTooLongError, dilempar
   * SEGERA saat tokenisasi melewatinya (tidak menunggu seluruh teks selesai
   * di-encode — tokenisasi sinkron 5 MB teks bisa memblokir server belasan detik).
   */
  maxTokens?: number;
};

/** Dokumen melebihi ChunkOptions.maxTokens. */
export class DocumentTooLongError extends Error {
  readonly maxTokens: number;
  constructor(maxTokens: number) {
    super(`Dokumen melebihi ${maxTokens} token.`);
    this.name = "DocumentTooLongError";
    this.maxTokens = maxTokens;
  }
}

// --- Tokenizer ---------------------------------------------------------------

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  // Membangun tabel BPE butuh ±0,3 detik → buat sekali, saat pertama dipakai.
  encoder ??= new Tiktoken(cl100k_base);
  return encoder;
}

/**
 * "Kata" (deretan karakter di antara dua titik potong aman) yang lebih panjang
 * dari ini dipotong paksa sebelum di-encode. Alasannya: BPE di js-tiktoken
 * O(n²) per potongan — file 5 MB berisi "aaaa…" tanpa spasi bisa mengunci
 * server berjam-jam (DoS murah). Dengan batas ini biayanya linear.
 *
 * Diukur dalam BYTE UTF-8 karena BPE bekerja di level byte (1 huruf Kanji =
 * 3 byte). 24 byte cukup untuk kata Indonesia panjang seperti
 * "mempertanggungjawabkan" (22) tetap utuh; kata yang lebih panjang (URL dsb.)
 * hasil hitungannya bisa selisih ±1 token — tidak masalah untuk chunking.
 */
const MAX_RUN_BYTES = 24;
/** Segmen di-encode per ±2000 karakter supaya overhead encode() tetap kecil. */
const SEGMENT_TARGET_CHARS = 2000;

function isWhitespaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 160;
}

/**
 * Titik potong "aman" di posisi i: tepat SEBELUM spasi yang diikuti karakter
 * non-spasi (" kata"), atau tepat SESUDAH newline yang diikuti non-spasi
 * ("\nKata"). Di titik-titik ini regex pre-tokenizer cl100k selalu memulai
 * potongan baru, jadi untuk teks normal hasil encode per segmen IDENTIK dengan
 * encode sekaligus (dicek di tests/chunk.test.ts).
 */
function isSafeCut(text: string, i: number): boolean {
  const code = text.charCodeAt(i);
  if (isWhitespaceCode(code)) {
    return code === 32 && i + 1 < text.length && !isWhitespaceCode(text.charCodeAt(i + 1));
  }
  return text.charCodeAt(i - 1) === 10;
}

/** Jumlah byte UTF-8 untuk 1 code unit UTF-16 (surrogate pair = 2 + 2 byte). */
function utf8Bytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 2;
  return 3;
}

/** Bagi teks jadi segmen pendek yang di-encode terpisah (lihat MAX_RUN_BYTES). */
function* encodingSegments(text: string): Generator<string> {
  let segmentStart = 0;
  let runBytes = text.length > 0 ? utf8Bytes(text.charCodeAt(0)) : 0;
  for (let i = 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isSafeCut(text, i)) {
      runBytes = 0;
      if (i - segmentStart >= SEGMENT_TARGET_CHARS) {
        yield text.slice(segmentStart, i);
        segmentStart = i;
      }
    } else if (runBytes >= MAX_RUN_BYTES && !(code >= 0xdc00 && code <= 0xdfff)) {
      // Potong paksa run yang terlalu panjang — tapi jangan di tengah
      // surrogate pair (emoji), nanti jadi karakter rusak.
      yield text.slice(segmentStart, i);
      segmentStart = i;
      runBytes = 0;
    }
    runBytes += utf8Bytes(code);
  }
  if (segmentStart < text.length) yield text.slice(segmentStart);
}

function encodeTokens(text: string, maxTokens = Number.POSITIVE_INFINITY): number[] {
  const enc = getEncoder();
  const tokens: number[] = [];
  for (const segment of encodingSegments(text)) {
    // `[], []` = perlakukan "<|endoftext|>" dkk sebagai teks biasa. Default-nya
    // encode() MELEMPAR error → dokumen berisi string itu bikin pipeline gagal.
    for (const token of enc.encode(segment, [], [])) tokens.push(token);
    if (tokens.length > maxTokens) throw new DocumentTooLongError(maxTokens);
  }
  return tokens;
}

/** Hitung token teks dengan tokenizer yang sama dengan model embedding. */
export function countTokens(text: string): number {
  return text.length === 0 ? 0 : encodeTokens(text).length;
}

// --- Sliding window ----------------------------------------------------------

function assertValidOptions(size: number, overlap: number): void {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`chunkTokens harus bilangan bulat > 0 (dapat: ${size}).`);
  }
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new RangeError(`overlapTokens harus bilangan bulat ≥ 0 (dapat: ${overlap}).`);
  }
  if (overlap >= size) {
    // overlap ≥ size → window tidak pernah maju → loop tak berujung.
    throw new RangeError(
      `overlapTokens (${overlap}) harus lebih kecil dari chunkTokens (${size}).`,
    );
  }
}

/**
 * Rencanakan window [start, end) di atas `total` token.
 *
 * - Window berikutnya mulai `overlap` token sebelum akhir window sebelumnya
 *   (step = size - overlap).
 * - Berhenti begitu sebuah window menyentuh akhir teks. Loop naif
 *   `for (start = 0; start < total; start += step)` menghasilkan chunk ekor kecil
 *   yang isinya SUDAH ada di chunk sebelumnya (bug off-by-one klasik).
 * - `snap(i)` boleh memundurkan batas (≤ i) ke posisi yang lebih rapi; karena
 *   hanya mundur, chunk tidak pernah melebihi `size`.
 */
function planWindows(
  total: number,
  size: number,
  overlap: number,
  snap: (index: number) => number = (index) => index,
): Array<[number, number]> {
  const windows: Array<[number, number]> = [];
  let start = 0;
  while (start < total) {
    let end = Math.min(start + size, total);
    if (end < total) {
      const snapped = snap(end);
      if (snapped > start) end = snapped;
    }
    windows.push([start, end]);
    if (end >= total) break;

    const next = end - overlap;
    const snappedNext = snap(next);
    // Jaga agar window selalu maju (kasus ekstrem: size kecil + snap jauh).
    if (snappedNext > start) start = snappedNext;
    else start = next > start ? next : end;
  }
  return windows;
}

/**
 * Potong deretan token jadi window berukuran `size` dengan overlap PERSIS
 * `overlap` token. Diekspor supaya test bisa memverifikasi overlap secara eksak.
 */
export function splitTokens(tokens: number[], size: number, overlap: number): number[][] {
  assertValidOptions(size, overlap);
  return planWindows(tokens.length, size, overlap).map(([start, end]) =>
    tokens.slice(start, end),
  );
}

// --- Batas chunk yang rapi -----------------------------------------------------

/** Seberapa jauh (token) batas boleh dimundurkan demi jatuh di awal kata. */
const MAX_SNAP_BACK_TOKENS = 8;

/**
 * Apakah batas sebelum token ke-`index` TIDAK membelah satu karakter?
 *
 * Emoji / aksara non-Latin bisa terdiri dari beberapa token (BPE bekerja di
 * level byte). Decode potongan yang terbelah menghasilkan "�". Triknya: batas
 * aman kalau decode kiri + decode kanan == decode gabungan. 1 karakter UTF-8
 * maks 4 byte, jadi 3 token di tiap sisi sudah cukup.
 */
function isCharBoundary(enc: Tiktoken, tokens: number[], index: number): boolean {
  const left = tokens.slice(Math.max(0, index - 3), index);
  const right = tokens.slice(index, index + 3);
  return enc.decode(left) + enc.decode(right) === enc.decode([...left, ...right]);
}

/**
 * Mundurkan batas ke awal kata/baris terdekat (token diawali spasi/newline),
 * supaya potongan yang tampil di panel sitasi tidak mulai di tengah kata.
 * Kalau tidak ketemu (mis. teks tanpa spasi seperti bahasa Jepang), minimal
 * pastikan tidak membelah karakter.
 */
function snapToBoundary(enc: Tiktoken, tokens: number[], index: number): number {
  for (let j = index; j > 0 && index - j <= MAX_SNAP_BACK_TOKENS; j--) {
    if (/^\s/.test(enc.decode([tokens[j]]))) return j;
  }
  for (let j = index; j > 0 && index - j <= 3; j--) {
    if (isCharBoundary(enc, tokens, j)) return j;
  }
  return index;
}

/**
 * Potong teks jadi chunk ±`chunkTokens` token dengan overlap ±`overlapTokens`.
 *
 * Batas chunk dimundurkan sedikit (maks beberapa token) ke awal kata, jadi
 * overlap aktual bisa sedikit LEBIH besar dari yang di-set dan chunk sedikit
 * lebih kecil — tidak pernah melebihi `chunkTokens`.
 * Melempar DocumentTooLongError kalau teks melebihi `maxTokens`.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const size = opts.chunkTokens ?? CHUNK_TOKENS;
  const overlap = opts.overlapTokens ?? CHUNK_OVERLAP_TOKENS;
  assertValidOptions(size, overlap);
  if (text.trim() === "") return [];

  const enc = getEncoder();
  const tokens = encodeTokens(text, opts.maxTokens);
  const windows = planWindows(tokens.length, size, overlap, (index) =>
    snapToBoundary(enc, tokens, index),
  );

  const chunks: TextChunk[] = [];
  for (const [start, end] of windows) {
    const content = enc.decode(tokens.slice(start, end));
    // Chunk yang isinya spasi semua tidak berguna untuk retrieval.
    if (content.trim() === "") continue;
    chunks.push({ index: chunks.length, content, tokenCount: end - start });
  }
  return chunks;
}
