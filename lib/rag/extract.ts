import "server-only";

// Langkah 1 pipeline RAG (spec §3.1): ambil teks dari file.
// PDF lewat unpdf (build PDF.js untuk server/serverless), md/txt langsung decode.

import { extractText as extractPdfText, getResolvedPDFJS } from "unpdf";

import type { AllowedMimeType } from "@/lib/config";

import { normalizeExtractedText } from "./normalize";

/** Error dengan pesan yang AMAN & berguna untuk ditampilkan ke user. */
export class ExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractionError";
  }
}

// Batas sumber daya untuk PDF tak tepercaya (lihat README unpdf "Processing
// Untrusted PDFs"): file 5 MB bisa berisi ribuan halaman kosong, dan parsing
// berjalan di event loop yang sama dengan request lain.
const MAX_PDF_PAGES = 500;
const PDF_TIMEOUT_MS = 30_000;
/** Gambar raksasa (lebar × tinggi) tidak di-decode — kita hanya butuh teks. */
const MAX_PDF_IMAGE_PIXELS = 16_777_216;

/** Ekstrak + normalisasi teks. Melempar ExtractionError dengan pesan siap tampil. */
export async function extractText(bytes: Uint8Array, mimeType: AllowedMimeType): Promise<string> {
  if (mimeType === "application/pdf") {
    let raw: string;
    try {
      raw = await extractFromPdf(bytes);
    } catch (err) {
      throw toExtractionError(err);
    }
    return normalizeExtractedText(raw, { pdf: true });
  }
  // UTF-8 sudah divalidasi saat upload (detectFileType); BOM dibuang otomatis.
  return normalizeExtractedText(new TextDecoder("utf-8").decode(bytes));
}

async function extractFromPdf(bytes: Uint8Array): Promise<string> {
  // Pakai getDocument langsung (bukan getDocumentProxy) supaya kita memegang
  // loadingTask-nya: kalau timeout terjadi SAAT parsing awal, task tetap bisa
  // dihancurkan alih-alih jalan terus di background.
  const { getDocument } = await getResolvedPDFJS();
  const loadingTask = getDocument({
    // Kirim SALINAN: PDF.js boleh mengambil alih (transfer) buffer yang
    // diberikan, sementara `bytes` milik pemanggil mungkin masih dipakai.
    data: bytes.slice(),
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
    verbosity: 0, // hanya error; warning font dsb. tidak perlu memenuhi log
  });
  const deadline = createDeadline(PDF_TIMEOUT_MS);
  try {
    const pdf = await deadline.race(loadingTask.promise);
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new ExtractionError(
        `PDF terlalu panjang (${pdf.numPages} halaman). Maksimal ${MAX_PDF_PAGES} halaman.`,
      );
    }
    const { text } = await deadline.race(extractPdfText(pdf, { mergePages: true }));
    return text;
  } finally {
    deadline.clear();
    // Bebaskan memori PDF.js (juga menghentikan kerja yang tertunda saat timeout).
    await loadingTask.destroy().catch(() => {});
  }
}

function toExtractionError(err: unknown): ExtractionError {
  if (err instanceof ExtractionError) return err;
  // Class exception PDF.js ada di dalam bundle unpdf → cek lewat `name`.
  const name = err instanceof Error ? err.name : "";
  if (name === "PasswordException") {
    return new ExtractionError(
      "PDF ini dilindungi password. Buka proteksinya dulu, lalu upload ulang.",
      { cause: err },
    );
  }
  if (name === "InvalidPDFException" || name === "FormatError") {
    return new ExtractionError("File PDF rusak atau tidak valid.", { cause: err });
  }
  return new ExtractionError("Gagal membaca isi PDF. Coba simpan ulang PDF-nya lalu upload lagi.", {
    cause: err,
  });
}

/** Timeout bersama untuk beberapa langkah async (Promise.race + clearTimeout). */
function createDeadline(ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ExtractionError("Membaca PDF terlalu lama (timeout). Coba file yang lebih kecil.")),
      ms,
    );
  });
  // Cegah "unhandled rejection" kalau deadline lewat saat tidak ada yang menunggu.
  expired.catch(() => {});
  return {
    race<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([promise, expired]);
    },
    clear() {
      clearTimeout(timer);
    },
  };
}
