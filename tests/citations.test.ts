import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  citationIndexFromHref,
  findSource,
  linkifyCitations,
  parseCitations,
  uniqueCitations,
} from "@/lib/citations";
import type { Source } from "@/lib/types";

function pick(text: string): Array<[string, number]> {
  return parseCitations(text).map((c) => [c.filename, c.chunkIndex]);
}

function source(filename: string, chunkIndex: number): Source {
  return { id: `${filename}-${chunkIndex}`, documentId: "doc", filename, chunkIndex, content: "isi", similarity: 0.8 };
}

describe("parseCitations", () => {
  it("format standar + posisi & raw yang tepat", () => {
    const text = "Cuti 12 hari [panduan.pdf, chunk #3].";
    const [citation] = parseCitations(text);
    assert.deepEqual(citation, {
      filename: "panduan.pdf",
      chunkIndex: 3,
      raw: "[panduan.pdf, chunk #3]",
      start: 13,
      end: 36,
    });
    assert.equal(text.slice(citation.start, citation.end), citation.raw);
  });

  it("toleran variasi penulisan dari model", () => {
    assert.deepEqual(pick("[a.pdf, Chunk #1] [b.md,chunk#2] [c.txt, chunk # 3] [d.pdf, CHUNK 4]"), [
      ["a.pdf", 1],
      ["b.md", 2],
      ["c.txt", 3],
      ["d.pdf", 4],
    ]);
  });

  it("nama file berisi spasi, titik, dan koma → dipisah di koma TERAKHIR", () => {
    assert.deepEqual(pick("[Laporan Q1, final v2.1.pdf, chunk #12]"), [["Laporan Q1, final v2.1.pdf", 12]]);
  });

  it("beberapa sitasi berurutan dan sitasi gabungan dengan titik koma", () => {
    assert.deepEqual(pick("[a.pdf, chunk #1][b.md, chunk #4]"), [
      ["a.pdf", 1],
      ["b.md", 4],
    ]);
    const grouped = parseCitations("lihat [a.pdf, chunk #1; b.md, chunk #4]");
    assert.deepEqual(
      grouped.map((c) => [c.filename, c.chunkIndex]),
      [
        ["a.pdf", 1],
        ["b.md", 4],
      ],
    );
    // Entri dari bracket yang sama berbagi posisi.
    assert.equal(grouped[0].start, grouped[1].start);
  });

  it("titik koma di nama file tidak memecah sitasi kalau bagiannya bukan sitasi", () => {
    assert.deepEqual(pick("[catatan;rapat.md, chunk #2]"), [["catatan;rapat.md", 2]]);
  });

  it("membuang pembungkus kutip / backtick / tebal di nama file", () => {
    assert.deepEqual(pick('["a.pdf", chunk #1] [`b.md`, chunk #2] [**c.txt**, chunk #3]'), [
      ["a.pdf", 1],
      ["b.md", 2],
      ["c.txt", 3],
    ]);
  });

  it("bukan sitasi: link markdown, bracket biasa, placeholder, bracket lintas baris", () => {
    assert.deepEqual(pick("[a.pdf, chunk #1](https://contoh.com)"), []);
    assert.deepEqual(pick("lihat [1] dan [catatan] serta [nama_file, chunk #n]"), []);
    assert.deepEqual(pick("[a.pdf,\nchunk #1]"), []);
    assert.deepEqual(pick("[, chunk #1]"), []);
  });
});

describe("uniqueCitations", () => {
  it("dedupe per file+chunk, urut kemunculan pertama", () => {
    const unique = uniqueCitations(
      parseCitations("[b.md, chunk #2] [a.pdf, chunk #1] [b.md, chunk #2] [b.md, chunk #3]"),
    );
    assert.deepEqual(
      unique.map((c) => [c.filename, c.chunkIndex]),
      [
        ["b.md", 2],
        ["a.pdf", 1],
        ["b.md", 3],
      ],
    );
  });
});

describe("linkifyCitations", () => {
  it("mengganti tiap marker dengan link #cite-<indeks> dan mempertahankan teks lain", () => {
    assert.equal(
      linkifyCitations("Cuti 12 hari [a.pdf, chunk #3]. Lembur [b.md, chunk #1]."),
      "Cuti 12 hari [0](#cite-0). Lembur [1](#cite-1).",
    );
  });

  it("indeks link sama dengan indeks parseCitations, termasuk sitasi gabungan", () => {
    const text = "x [a.pdf, chunk #1; b.md, chunk #2] y [c.txt, chunk #5]";
    assert.equal(linkifyCitations(text), "x [0](#cite-0)[1](#cite-1) y [2](#cite-2)");
    const citations = parseCitations(text);
    assert.equal(citations[2].filename, "c.txt");
  });

  it("teks tanpa sitasi dikembalikan apa adanya", () => {
    const text = "Tidak ada sumber di sini [catatan].";
    assert.equal(linkifyCitations(text), text);
  });

  it("nama file dengan karakter markdown tidak merusak link (href hanya angka)", () => {
    assert.equal(linkifyCitations("[my_(draft)*.md, chunk #2]"), "[0](#cite-0)");
  });
});

describe("citationIndexFromHref", () => {
  it("hanya menerima #cite-<angka>", () => {
    assert.equal(citationIndexFromHref("#cite-4"), 4);
    assert.equal(citationIndexFromHref("#cite-"), null);
    assert.equal(citationIndexFromHref("#cite-4x"), null);
    assert.equal(citationIndexFromHref("https://contoh.com/#cite-1"), null);
    assert.equal(citationIndexFromHref(undefined), null);
  });
});

describe("findSource", () => {
  const sources = [source("Panduan HR.pdf", 3), source('kontrak "final".md', 0)];

  it("cocok persis file + chunk", () => {
    assert.equal(findSource({ filename: "Panduan HR.pdf", chunkIndex: 3 }, sources), sources[0]);
  });

  it("toleran huruf besar/kecil, spasi, dan entity yang disalin model dari context", () => {
    assert.equal(findSource({ filename: " panduan hr.PDF ", chunkIndex: 3 }, sources), sources[0]);
    assert.equal(findSource({ filename: "kontrak &quot;final&quot;.md", chunkIndex: 0 }, sources), sources[1]);
  });

  it("chunk yang tidak diambil saat retrieval → undefined (tidak terverifikasi)", () => {
    assert.equal(findSource({ filename: "Panduan HR.pdf", chunkIndex: 4 }, sources), undefined);
    assert.equal(findSource({ filename: "lain.pdf", chunkIndex: 3 }, sources), undefined);
  });
});
