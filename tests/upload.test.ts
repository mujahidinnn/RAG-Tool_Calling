import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  detectFileType,
  getAllowedExtension,
  readStreamWithLimit,
  sanitizeFilename,
  uniqueFilename,
} from "@/lib/server/upload";

const encoder = new TextEncoder();

/** Stream dari potongan-potongan byte, plus penanda apakah stream dibatalkan. */
function streamOf(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; state: { cancelled: boolean; pulled: number } } {
  const state = { cancelled: false, pulled: 0 };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        state.pulled++;
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** Stream "tak berujung" — mensimulasikan client yang terus mengirim data. */
function endlessStream(chunkSize: number): { stream: ReadableStream<Uint8Array>; state: { cancelled: boolean; pulled: number } } {
  const state = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled++;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe("readStreamWithLimit", () => {
  test("menggabungkan potongan body secara utuh", async () => {
    const { stream } = streamOf([encoder.encode("halo "), encoder.encode("dunia")]);
    const result = await readStreamWithLimit(stream, 100);
    assert.equal(result.ok, true);
    assert.equal(result.ok && new TextDecoder().decode(result.bytes), "halo dunia");
  });

  test("tepat sama dengan batas → diterima", async () => {
    const { stream } = streamOf([new Uint8Array(6), new Uint8Array(4)]);
    const result = await readStreamWithLimit(stream, 10);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.bytes.byteLength, 10);
  });

  test("lewat 1 byte → ditolak too_large dan stream dibatalkan", async () => {
    const { stream, state } = streamOf([new Uint8Array(6), new Uint8Array(5), new Uint8Array(100)]);
    const result = await readStreamWithLimit(stream, 10);
    assert.deepEqual(result, { ok: false, reason: "too_large" });
    assert.equal(state.cancelled, true);
    assert.ok(state.pulled <= 2, "tidak boleh terus membaca setelah batas terlewati");
  });

  test("body tak berujung (Content-Length bohong) tetap berhenti di batas", async () => {
    // Client bisa mengaku "Content-Length: 10" lalu mengirim terus — yang
    // dihitung adalah byte nyata, jadi pembacaan berhenti tanpa menunggu akhir.
    const { stream, state } = endlessStream(64 * 1024);
    const result = await readStreamWithLimit(stream, 5 * 1024 * 1024);
    assert.deepEqual(result, { ok: false, reason: "too_large" });
    assert.equal(state.cancelled, true);
    assert.ok(state.pulled <= 81 + 2, `terbaca ${state.pulled} potongan`);
  });

  test("body kosong / null → empty", async () => {
    assert.deepEqual(await readStreamWithLimit(null, 10), { ok: false, reason: "empty" });
    const { stream } = streamOf([]);
    assert.deepEqual(await readStreamWithLimit(stream, 10), { ok: false, reason: "empty" });
    const zeroChunks = streamOf([new Uint8Array(0), new Uint8Array(0)]);
    assert.deepEqual(await readStreamWithLimit(zeroChunks.stream, 10), { ok: false, reason: "empty" });
  });
});

describe("detectFileType", () => {
  const pdfBytes = encoder.encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");

  test("PDF asli diterima", () => {
    assert.deepEqual(detectFileType(pdfBytes, "laporan.PDF"), {
      ok: true,
      mimeType: "application/pdf",
      extension: ".pdf",
    });
  });

  test("markdown & txt UTF-8 diterima (termasuk BOM, tab, CRLF, emoji)", () => {
    const md = encoder.encode("﻿# Judul\r\n\n- poin\tsatu 🙂\n");
    assert.deepEqual(detectFileType(md, "catatan.md"), { ok: true, mimeType: "text/markdown", extension: ".md" });
    assert.deepEqual(detectFileType(encoder.encode("halo"), "a.txt"), {
      ok: true,
      mimeType: "text/plain",
      extension: ".txt",
    });
  });

  test(".pdf yang isinya bukan PDF ditolak", () => {
    const result = detectFileType(encoder.encode("bukan pdf"), "palsu.pdf");
    assert.equal(result.ok, false);
  });

  test(".txt yang sebenarnya PDF ditolak", () => {
    const result = detectFileType(pdfBytes, "menyamar.txt");
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /sebenarnya PDF/);
  });

  test("file biner (NUL byte / PNG) dengan ekstensi .txt ditolak", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    assert.equal(detectFileType(png, "gambar.txt").ok, false);
    assert.equal(detectFileType(new Uint8Array([0x68, 0x00, 0x69]), "nul.md").ok, false);
  });

  test("bukan UTF-8 valid (mis. Latin-1) ditolak", () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" dalam Latin-1
    const result = detectFileType(latin1, "latin1.txt");
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /UTF-8/);
  });

  test("terlalu banyak karakter kontrol ditolak", () => {
    const bytes = encoder.encode("abc\u0001\u0002\u0003\u0004def");
    assert.equal(detectFileType(bytes, "kontrol.txt").ok, false);
  });

  test("ekstensi tidak didukung ditolak walau isinya teks", () => {
    for (const name of ["skrip.js", "dokumen.docx", "arsip.tar.gz", "tanpa-ekstensi", "a.pdf.exe"]) {
      assert.equal(detectFileType(encoder.encode("teks biasa"), name).ok, false, name);
    }
  });
});

describe("getAllowedExtension", () => {
  test("hanya ekstensi terakhir, tidak peka huruf besar", () => {
    assert.equal(getAllowedExtension("A.MD"), ".md");
    assert.equal(getAllowedExtension("x.pdf.txt"), ".txt");
    assert.equal(getAllowedExtension("x.txt.pdf"), ".pdf");
    assert.equal(getAllowedExtension("x.markdown"), null);
    assert.equal(getAllowedExtension(".txt"), ".txt");
  });
});

describe("sanitizeFilename", () => {
  test("path traversal dibuang", () => {
    assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
    assert.equal(sanitizeFilename("..\\..\\windows\\system32\\laporan.pdf"), "laporan.pdf");
    assert.equal(sanitizeFilename(encodeURIComponent("../../rahasia.txt")), "rahasia.txt");
    assert.equal(sanitizeFilename(".."), "dokumen");
    assert.equal(sanitizeFilename("folder/"), "dokumen");
  });

  test("decode URI component (header X-Filename)", () => {
    assert.equal(sanitizeFilename(encodeURIComponent("Laporan Tahunan 2026 – final.pdf")), "Laporan Tahunan 2026 – final.pdf");
    // URI tidak valid → dipakai apa adanya, tidak melempar.
    assert.equal(sanitizeFilename("diskon%ZZ.txt"), "diskon%ZZ.txt");
  });

  test("kurung siku (merusak sitasi) & tanda kutip / <> dibuang", () => {
    assert.equal(sanitizeFilename("[draft] catatan [v2].md"), "draft catatan v2.md");
    assert.equal(sanitizeFilename('a"b<c>d.txt'), "abcd.txt");
  });

  test("karakter kontrol & pembalik arah teks dibuang, spasi dirapikan", () => {
    assert.equal(sanitizeFilename("lap\u0000or\u001fan\u007f.txt"), "laporan.txt");
    assert.equal(sanitizeFilename("invoice‮fdp.txt"), "invoicefdp.txt");
    assert.equal(sanitizeFilename("  banyak \t\n  spasi   .md "), "banyak spasi .md");
  });

  test("maks 120 karakter dengan ekstensi tetap utuh", () => {
    const long = `${"a".repeat(300)}.pdf`;
    const result = sanitizeFilename(long);
    assert.equal(result.length, 120);
    assert.ok(result.endsWith(".pdf"));
    // Emoji di batas potong tidak boleh terbelah.
    const emoji = sanitizeFilename(`${"😀".repeat(200)}.md`);
    assert.ok(!emoji.includes("�"));
    assert.equal(Array.from(emoji).length, 120);
    assert.ok(emoji.endsWith(".md"));
  });

  test("kosong → fallback", () => {
    assert.equal(sanitizeFilename(""), "dokumen");
    assert.equal(sanitizeFilename("   "), "dokumen");
    assert.equal(sanitizeFilename("[]"), "dokumen");
  });
});

describe("uniqueFilename", () => {
  test("nama kembar diberi nomor", () => {
    assert.equal(uniqueFilename("a.pdf", []), "a.pdf");
    assert.equal(uniqueFilename("a.pdf", ["A.PDF"]), "a (2).pdf");
    assert.equal(uniqueFilename("a.pdf", ["a.pdf", "a (2).pdf"]), "a (3).pdf");
    assert.equal(uniqueFilename("catatan", ["catatan"]), "catatan (2)");
  });
});
