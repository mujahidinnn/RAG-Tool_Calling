// Unit test chunking (spec §9). Fokus ke bug yang biasanya "diam-diam":
// off-by-one di overlap, chunk ekor duplikat, chunk melebihi batas token,
// teks hilang/terduplikasi di batas chunk, karakter multibyte terbelah.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

import { CHUNK_OVERLAP_TOKENS, CHUNK_TOKENS } from "@/lib/config";
import { DocumentTooLongError, chunkText, countTokens, splitTokens, type TextChunk } from "@/lib/rag/chunk";

// --- Helper ------------------------------------------------------------------

/** Rumus jumlah window yang diharapkan (dihitung independen dari implementasi). */
function expectedWindowCount(total: number, size: number, overlap: number): number {
  if (total === 0) return 0;
  if (total <= size) return 1;
  return 1 + Math.ceil((total - size) / (size - overlap));
}

/** Panjang overlap terpanjang: suffix `a` yang sama dengan prefix `b`. */
function longestSuffixPrefix(a: string, b: string): number {
  for (let k = Math.min(a.length, b.length); k > 0; k--) {
    if (a.endsWith(b.slice(0, k))) return k;
  }
  return 0;
}

/** Gabungkan kembali chunk dengan membuang bagian overlap → harus = teks asli. */
function stitch(chunks: TextChunk[]): { text: string; overlaps: string[] } {
  let text = chunks[0].content;
  const overlaps: string[] = [];
  for (let i = 1; i < chunks.length; i++) {
    const k = longestSuffixPrefix(chunks[i - 1].content, chunks[i].content);
    assert.ok(k > 0, `chunk #${i} tidak overlap dengan chunk #${i - 1}`);
    overlaps.push(chunks[i].content.slice(0, k));
    text += chunks[i].content.slice(k);
  }
  return { text, overlaps };
}

/** PRNG deterministik (LCG) supaya input test selalu sama. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** Kata bahasa Inggris yang masing-masing tepat 1 token (dengan spasi di depan). */
const SINGLE_TOKEN_WORDS = [
  "the", "data", "model", "river", "house", "table", "green", "music", "light", "water",
  "paper", "night", "school", "money", "garden", "window", "letter", "summer", "number", "market",
];

/** Prosa Indonesia yang tidak berulang (tiap kalimat bernomor) + heading markdown. */
function makeProse(sentences: number): string {
  const subjects = ["Sistem", "Pengguna", "Model bahasa", "Database vektor", "Tim engineering", "Dokumen ini"];
  const verbs = ["menyimpan", "membaca", "memproses", "mengirim", "memvalidasi", "meringkas"];
  const objects = ["potongan teks", "embedding", "riwayat percakapan", "file PDF", "sitasi sumber", "token"];
  let text = "";
  for (let i = 0; i < sentences; i++) {
    text +=
      `${subjects[i % 6]} ${verbs[(i * 7) % 6]} ${objects[(i * 5) % 6]} nomor ${i + 1} ` +
      `dengan hati-hati, lalu mencatat hasilnya (kode ${(i * 7919) % 10_007}).`;
    text += i % 9 === 8 ? `\n\n## Bagian ${(i + 1) / 9}\n\n` : " ";
  }
  return text.trim();
}

// --- splitTokens: overlap eksak di level token -------------------------------

describe("splitTokens", () => {
  const cases: Array<[total: number, size: number, overlap: number]> = [
    [1234, 500, 50],
    [2000, 500, 50],
    [950, 500, 50], // tepat pas: TIDAK boleh ada chunk ekor ke-3
    [951, 500, 50],
    [501, 500, 50],
    [500, 500, 50],
    [1, 500, 50],
    [10, 3, 0],
    [10, 3, 2],
    [100, 1, 0],
    [37, 7, 6],
  ];

  for (const [total, size, overlap] of cases) {
    test(`total=${total} size=${size} overlap=${overlap}`, () => {
      const tokens = Array.from({ length: total }, (_, i) => i);
      const windows = splitTokens(tokens, size, overlap);

      assert.equal(windows.length, expectedWindowCount(total, size, overlap), "jumlah chunk");
      assert.deepEqual(windows[0].slice(0, 1), [0], "chunk pertama mulai dari token pertama");
      assert.equal(windows.at(-1)?.at(-1), total - 1, "chunk terakhir berakhir di token terakhir");

      windows.forEach((w, i) => {
        assert.ok(w.length > 0, `chunk #${i} kosong`);
        assert.ok(w.length <= size, `chunk #${i} melebihi ${size} token`);
        if (i < windows.length - 1) assert.equal(w.length, size, `chunk #${i} harus penuh`);
      });

      for (let i = 1; i < windows.length; i++) {
        const prev = windows[i - 1];
        const cur = windows[i];
        // Overlap PERSIS `overlap` token: ekor chunk sebelumnya = kepala chunk ini.
        assert.deepEqual(cur.slice(0, overlap), prev.slice(prev.length - overlap), `overlap #${i}`);
        // Tepat setelah overlap, token berlanjut tanpa celah/duplikasi.
        assert.equal(cur[overlap], prev[prev.length - 1] + 1, `kontinuitas #${i}`);
        // Chunk ekor tidak boleh sepenuhnya terkandung di chunk sebelumnya.
        assert.ok(cur[cur.length - 1] > prev[prev.length - 1], `chunk #${i} duplikat ekor`);
      }
    });
  }

  test("contoh konkret 1234 token → [0..499], [450..949], [900..1233]", () => {
    const tokens = Array.from({ length: 1234 }, (_, i) => i);
    const ranges = splitTokens(tokens, 500, 50).map((w) => [w[0], w[w.length - 1]]);
    assert.deepEqual(ranges, [
      [0, 499],
      [450, 949],
      [900, 1233],
    ]);
  });

  test("input kosong → tidak ada chunk", () => {
    assert.deepEqual(splitTokens([], 500, 50), []);
  });

  test("opsi tidak valid dilempar sebagai RangeError", () => {
    const tokens = [1, 2, 3];
    for (const [size, overlap] of [
      [0, 0],
      [-5, 0],
      [10, 10], // overlap = size → window tidak pernah maju
      [10, 11],
      [10, -1],
      [2.5, 0],
      [10, 1.5],
      [Number.NaN, 0],
    ]) {
      assert.throws(() => splitTokens(tokens, size, overlap), RangeError, `size=${size} overlap=${overlap}`);
    }
  });
});

// --- chunkText: perilaku di teks sungguhan ------------------------------------

describe("chunkText", () => {
  test("teks kosong / spasi saja → []", () => {
    assert.deepEqual(chunkText(""), []);
    assert.deepEqual(chunkText("   \n\t \n "), []);
  });

  test("teks pendek → 1 chunk berisi teks utuh", () => {
    const text = "Halo! Ini dokumen pendek tentang RAG.";
    const chunks = chunkText(text);
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], { index: 0, content: text, tokenCount: countTokens(text) });
  });

  test("teks panjang (default 500/50): jumlah chunk, batas token, overlap 50 persis", () => {
    for (const word of SINGLE_TOKEN_WORDS) {
      assert.equal(countTokens(` ${word}`), 1, `prasyarat: " ${word}" harus 1 token`);
    }
    const random = makeRandom(42);
    const words = Array.from(
      { length: 2345 },
      () => SINGLE_TOKEN_WORDS[Math.floor(random() * SINGLE_TOKEN_WORDS.length)],
    );
    const text = words.map((w) => ` ${w}`).join("");
    assert.equal(countTokens(text), words.length, "prasyarat: 1 kata = 1 token");

    const chunks = chunkText(text);

    // 2345 token, size 500, step 450 → 1 + ceil(1845 / 450) = 6 chunk.
    assert.equal(chunks.length, expectedWindowCount(words.length, CHUNK_TOKENS, CHUNK_OVERLAP_TOKENS));
    assert.equal(chunks.length, 6);

    const wordsOf = (c: TextChunk) => c.content.trim().split(/\s+/);
    chunks.forEach((chunk, i) => {
      assert.equal(chunk.index, i, "index berurutan mulai 0");
      assert.ok(chunk.tokenCount <= CHUNK_TOKENS, `chunk #${i}: ${chunk.tokenCount} token`);
      assert.ok(countTokens(chunk.content) <= CHUNK_TOKENS, `chunk #${i} di-encode ulang`);
      assert.equal(wordsOf(chunk).length, chunk.tokenCount);
    });

    for (let i = 1; i < chunks.length; i++) {
      const prev = wordsOf(chunks[i - 1]);
      const cur = wordsOf(chunks[i]);
      assert.deepEqual(cur.slice(0, CHUNK_OVERLAP_TOKENS), prev.slice(-CHUNK_OVERLAP_TOKENS), `overlap #${i}`);
    }

    // Tidak ada kata yang hilang / terduplikasi setelah overlap dibuang.
    const rebuilt = [
      ...wordsOf(chunks[0]),
      ...chunks.slice(1).flatMap((c) => wordsOf(c).slice(CHUNK_OVERLAP_TOKENS)),
    ];
    assert.deepEqual(rebuilt, words);
  });

  test("prosa natural: batas di awal kata, overlap ≥ yang di-set, teks utuh bisa direkonstruksi", () => {
    const text = makeProse(160);
    const size = 120;
    const overlap = 20;
    const chunks = chunkText(text, { chunkTokens: size, overlapTokens: overlap });

    assert.ok(chunks.length >= expectedWindowCount(countTokens(text), size, overlap));
    chunks.forEach((chunk, i) => {
      assert.ok(chunk.tokenCount <= size, `chunk #${i}: ${chunk.tokenCount} token`);
      assert.ok(countTokens(chunk.content) <= size, `chunk #${i} di-encode ulang`);
      // Batas dimundurkan maks 8 token, jadi chunk (selain terakhir) tetap hampir penuh.
      if (i < chunks.length - 1) assert.ok(chunk.tokenCount >= size - 8, `chunk #${i} terlalu kecil`);
      // Chunk lanjutan mulai di awal kata, bukan di tengah kata.
      if (i > 0) assert.match(chunk.content, /^\s/, `chunk #${i} mulai di tengah kata`);
    });

    const { text: rebuilt, overlaps } = stitch(chunks);
    assert.equal(rebuilt, text, "teks hasil gabungan harus sama persis dengan aslinya");
    for (const [i, shared] of overlaps.entries()) {
      const n = countTokens(shared);
      assert.ok(n >= overlap && n <= overlap + 8, `overlap #${i + 1} = ${n} token`);
    }
  });

  test("emoji & aksara non-Latin tidak terbelah (tidak ada karakter rusak �)", () => {
    let text = "";
    for (let i = 0; i < 40; i++) {
      text += `Kalimat ${i}: halo 👋🏽 dunia 🇮🇩, naïve café — 漢字テキスト${i}を分割する🙂✓ `;
    }
    // Teks tanpa spasi sama sekali → snapping ke awal kata tidak mungkin,
    // jadi yang diuji adalah penjaga batas karakter UTF-8.
    text += "日本語のテキストにはスペースがありません😀😃😄😁😆😅🤣😂".repeat(10);

    const chunks = chunkText(text, { chunkTokens: 16, overlapTokens: 4 });
    assert.ok(chunks.length > 20);
    for (const chunk of chunks) {
      assert.ok(!chunk.content.includes("�"), `karakter terbelah di: ${JSON.stringify(chunk.content)}`);
      assert.ok(chunk.tokenCount <= 16);
    }
    assert.equal(stitch(chunks).text, text);
  });

  test("string token spesial (<|endoftext|>) diperlakukan sebagai teks biasa", () => {
    const text = "Awal dokumen. <|endoftext|> Lanjutan setelah token spesial <|fim_prefix|>.";
    const chunks = chunkText(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, text);
  });

  test(
    "run panjang tanpa spasi tetap cepat (BPE O(n²) tidak meledak)",
    { timeout: 30_000 },
    () => {
      // Tanpa pemotongan run, ini butuh berjam-jam (bukan sekadar lambat).
      const text = "a".repeat(300_000);
      const chunks = chunkText(text);
      const total = countTokens(text);
      assert.equal(chunks.length, expectedWindowCount(total, CHUNK_TOKENS, CHUNK_OVERLAP_TOKENS));
      for (const chunk of chunks) {
        assert.ok(chunk.tokenCount <= CHUNK_TOKENS);
        assert.match(chunk.content, /^a+$/);
      }
    },
  );

  test("opsi tidak valid dilempar", () => {
    assert.throws(() => chunkText("halo", { chunkTokens: 0 }), RangeError);
    assert.throws(() => chunkText("halo", { chunkTokens: 100, overlapTokens: 100 }), RangeError);
    assert.throws(() => chunkText("halo", { overlapTokens: -1 }), RangeError);
  });
});

// --- countTokens ---------------------------------------------------------------

describe("countTokens", () => {
  test("teks kosong → 0", () => {
    assert.equal(countTokens(""), 0);
  });

  test("sama persis dengan tokenizer cl100k untuk teks normal", () => {
    // Segmentasi internal (anti-DoS) tidak boleh mengubah hitungan untuk teks biasa.
    const reference = new Tiktoken(cl100k_base);
    const samples = [
      "hello world",
      makeProse(60),
      "Daftar:\n- satu\n- dua\n\n\n1. tiga\n\tindentasi   spasi ganda  \nIt's we're I'd.",
      "Pemerintah daerah mempertanggungjawabkan ketidakberdayaan masyarakat.",
    ];
    for (const sample of samples) {
      assert.equal(countTokens(sample), reference.encode(sample, [], []).length);
    }
  });
});

describe("chunkText — batas token dokumen (maxTokens)", () => {
  const long = "Kalimat contoh tentang kebijakan cuti karyawan. ".repeat(2000);

  test("melebihi maxTokens → DocumentTooLongError (sebelum chunking)", () => {
    assert.throws(() => chunkText(long, { maxTokens: 1000 }), (err: unknown) => {
      assert.ok(err instanceof DocumentTooLongError);
      assert.equal(err.maxTokens, 1000);
      return true;
    });
  });

  test("tepat di bawah batas → tetap di-chunk seperti biasa", () => {
    const total = countTokens(long);
    assert.deepEqual(chunkText(long, { maxTokens: total }), chunkText(long));
  });

  test("berhenti cepat: teks raksasa ditolak tanpa meng-encode seluruhnya", () => {
    const huge = "kata ".repeat(2_000_000); // ±10 juta karakter
    const started = Date.now();
    assert.throws(() => chunkText(huge, { maxTokens: 5_000 }), DocumentTooLongError);
    assert.ok(Date.now() - started < 2_000, `terlalu lama: ${Date.now() - started} ms`);
  });
});
