// Helper validasi upload (spec §2). MURNI — tanpa server-only / next — supaya
// bisa di-unit-test (tests/upload.test.ts).

import { ALLOWED_EXTENSIONS, type AllowedMimeType } from "@/lib/config";

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

const MIME_BY_EXTENSION: Record<AllowedExtension, AllowedMimeType> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

export const UNSUPPORTED_TYPE_MESSAGE =
  "Tipe file tidak didukung. Hanya .pdf, .md, dan .txt yang diizinkan.";

// --- Membaca body dengan batas ukuran -------------------------------------------

export type ReadStreamResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "empty" };

/**
 * Baca stream sambil MENGHITUNG byte yang benar-benar diterima.
 *
 * Header `Content-Length` tidak dipercaya: bisa dipalsukan, atau tidak ada sama
 * sekali (chunked transfer). Begitu total melewati `maxBytes`, pembacaan
 * dihentikan dan stream dibatalkan — sisa body (yang bisa berukuran GB) tidak
 * pernah ditampung di memori.
 */
export async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ReadStreamResult> {
  if (!stream) return { ok: false, reason: "empty" };

  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Tidak di-await: kita tidak butuh hasil cancel, cukup hentikan aliran data.
        reader.cancel("file terlalu besar").catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return { ok: false, reason: "empty" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { ok: true, bytes };
}

// --- Validasi tipe file berdasarkan ISI ----------------------------------------------

/** Ekstensi (huruf kecil, dengan titik) kalau termasuk yang diizinkan; selain itu null. */
export function getAllowedExtension(filename: string): AllowedExtension | null {
  const match = /\.[a-z0-9]+$/i.exec(filename);
  const ext = match?.[0].toLowerCase();
  return ALLOWED_EXTENSIONS.find((allowed) => allowed === ext) ?? null;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function startsWithPdfMagic(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((byte, i) => bytes[i] === byte);
}

/** Maks proporsi karakter kontrol di file teks sebelum dianggap biner. */
const MAX_CONTROL_CHAR_RATIO = 0.01;

/** Karakter kontrol C0 + DEL, kecuali tab/newline/CR/form feed yang wajar di file teks. */
function isSuspiciousControlChar(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c) return false;
  return code < 0x20 || code === 0x7f;
}

export type DetectFileTypeResult =
  | { ok: true; mimeType: AllowedMimeType; extension: AllowedExtension }
  | { ok: false; message: string };

/**
 * Validasi tipe file dari ISI-nya, bukan cuma ekstensi / header Content-Type
 * dari browser (keduanya dikontrol client, gampang dipalsukan).
 * - `.pdf` wajib diawali magic bytes "%PDF-".
 * - `.md` / `.txt` wajib UTF-8 valid, tanpa byte NUL, minim karakter kontrol,
 *   dan BUKAN PDF yang diganti ekstensinya.
 */
export function detectFileType(bytes: Uint8Array, filename: string): DetectFileTypeResult {
  const extension = getAllowedExtension(filename);
  if (!extension) return { ok: false, message: UNSUPPORTED_TYPE_MESSAGE };

  const isPdf = startsWithPdfMagic(bytes);
  if (extension === ".pdf") {
    return isPdf
      ? { ok: true, mimeType: MIME_BY_EXTENSION[extension], extension }
      : { ok: false, message: "File ini bukan PDF yang valid (isinya tidak sesuai ekstensi .pdf)." };
  }

  if (isPdf) {
    return {
      ok: false,
      message: `File ini sebenarnya PDF, bukan ${extension}. Ganti ekstensinya jadi .pdf lalu upload ulang.`,
    };
  }
  if (bytes.includes(0)) {
    return { ok: false, message: `File ${extension} ini berisi data biner, bukan teks biasa.` };
  }

  let text: string;
  try {
    // fatal: true → byte yang bukan UTF-8 valid langsung ditolak (bukan diganti "�").
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      message: `File ${extension} harus ber-encoding UTF-8. Simpan ulang file sebagai UTF-8 lalu coba lagi.`,
    };
  }

  let controlChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (isSuspiciousControlChar(text.charCodeAt(i))) controlChars++;
  }
  if (controlChars > text.length * MAX_CONTROL_CHAR_RATIO) {
    return { ok: false, message: `File ${extension} ini tampaknya file biner, bukan teks biasa.` };
  }

  return { ok: true, mimeType: MIME_BY_EXTENSION[extension], extension };
}

// --- Nama file ---------------------------------------------------------------------------

const MAX_FILENAME_LENGTH = 120;
const FALLBACK_FILENAME = "dokumen";

/**
 * Bersihkan nama file dari client SEBELUM disimpan / ditampilkan / dikirim ke LLM.
 * (Storage path tetap UUID — nama ini hanya label.)
 * - decode `encodeURIComponent` (header X-Filename),
 * - buang bagian path ("../../etc/passwd" → "passwd"),
 * - buang karakter kontrol & karakter Unicode tak terlihat / pembalik arah teks
 *   (trik "laporan‮fdp.exe" supaya nama tampil menipu),
 * - buang `[` `]` (merusak sintaks sitasi `[nama_file, chunk #n]`) dan `"` `<` `>`
 *   (dipakai sebagai pembungkus context untuk LLM),
 * - rapikan spasi, maks 120 karakter dengan ekstensi tetap utuh.
 */
export function sanitizeFilename(raw: string): string {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // Bukan URI-encoded yang valid → pakai apa adanya.
  }

  name = name.normalize("NFC");
  name = name.split(/[/\\]/).pop() ?? "";
  name = name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[[\]"<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^\.*$/.test(name)) return FALLBACK_FILENAME; // "", ".", ".."

  const chars = Array.from(name); // per code point, supaya emoji tidak terbelah
  if (chars.length > MAX_FILENAME_LENGTH) {
    const ext = /\.[a-z0-9]{1,10}$/i.exec(name)?.[0] ?? "";
    const base = chars.slice(0, MAX_FILENAME_LENGTH - ext.length).join("").trimEnd();
    name = base + ext;
  }
  return name;
}
