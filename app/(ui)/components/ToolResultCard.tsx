"use client";

import { ChevronDown, CircleCheck, FileSearch, NotebookText, TriangleAlert, Wrench } from "lucide-react";
import { useId, useState } from "react";
import { formatBytes } from "@/lib/client/format";
import type { ToolCardPayload } from "@/lib/types";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { Spinner, StatusBadge, cx } from "./ui";

type Props = {
  name: string;
  /** null = tool masih dijalankan di server. */
  result: ToolCardPayload | null;
};

const TOOL_TITLES: Record<string, string> = {
  list_uploaded_documents: "Cek daftar dokumen",
  get_document_summary: "Ringkas dokumen",
};

/**
 * Hasil tool call ditampilkan sebagai card terpisah dari bubble jawaban
 * (spec §5): user bisa melihat KAPAN model memakai tool dan apa hasilnya,
 * bukan cuma membaca jawaban akhirnya.
 */
export function ToolResultCard({ name, result }: Props) {
  const running = result === null;
  const failed = result?.kind === "error";

  return (
    <section
      aria-label={`Hasil tool ${name}`}
      aria-busy={running}
      className="animate-message-in overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <header className="flex items-center gap-2 border-b border-zinc-200/80 px-3 py-2 dark:border-zinc-800">
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-accent-100 text-accent-700 dark:bg-accent-400/15 dark:text-accent-300">
          <Wrench aria-hidden="true" className="size-3" />
        </span>
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{TOOL_TITLES[name] ?? "Tool call"}</span>
        <code className="hidden truncate font-mono text-[0.6875rem] text-zinc-500 sm:inline dark:text-zinc-400">{name}</code>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[0.6875rem] text-zinc-500 dark:text-zinc-400">
          {running ? (
            <>
              <Spinner className="size-3" />
              Menjalankan…
            </>
          ) : failed ? (
            <>
              <TriangleAlert aria-hidden="true" className="size-3 text-amber-600 dark:text-amber-400" />
              Gagal
            </>
          ) : (
            <>
              <CircleCheck aria-hidden="true" className="size-3 text-emerald-600 dark:text-emerald-400" />
              Selesai
            </>
          )}
        </span>
      </header>
      <div className="px-3 py-2.5">
        {result === null ? <RunningBody /> : <ResultBody payload={result} />}
      </div>
    </section>
  );
}

function RunningBody() {
  return (
    <div className="space-y-2 py-0.5" aria-hidden="true">
      <div className="skeleton h-2.5 w-2/3" />
      <div className="skeleton h-2.5 w-1/2" />
    </div>
  );
}

function ResultBody({ payload }: { payload: ToolCardPayload }) {
  switch (payload.kind) {
    case "documents":
      return (
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
            <FileSearch aria-hidden="true" className="size-4 text-zinc-500" />
            Dokumen ditemukan: {payload.documents.length}
          </p>
          {payload.documents.length === 0 ? (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Belum ada dokumen yang diupload di sesi ini.</p>
          ) : (
            <ul className="mt-2 divide-y divide-zinc-200/80 dark:divide-zinc-800">
              {payload.documents.map((doc) => (
                <li key={doc.id} className="flex items-center gap-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300" title={doc.filename}>
                    {doc.filename}
                  </span>
                  <span className="hidden shrink-0 text-zinc-500 tabular-nums sm:inline dark:text-zinc-400">
                    {formatBytes(doc.sizeBytes)}
                    {doc.status === "ready" ? ` · ${doc.chunkCount} chunk` : ""}
                  </span>
                  <StatusBadge status={doc.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case "summary":
      return <SummaryBody payload={payload} />;
    case "error":
      return (
        <p className="flex items-start gap-1.5 text-xs leading-5 text-amber-800 dark:text-amber-200">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {payload.message}
        </p>
      );
  }
}

/** Ringkasan bisa panjang → dipotong dulu dengan tombol "Tampilkan semua". */
function SummaryBody({ payload }: { payload: Extract<ToolCardPayload, { kind: "summary" }> }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const long = payload.summary.length > 600;
  const sampled = payload.chunksUsed < payload.totalChunks;

  return (
    <div>
      <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">
        <NotebookText aria-hidden="true" className="size-4 shrink-0 text-zinc-500" />
        <span className="min-w-0 truncate">Ringkasan: {payload.filename}</span>
      </p>
      <div
        id={contentId}
        className={cx("relative mt-2", long && !expanded && "max-h-48 overflow-hidden")}
      >
        {/* Ringkasan juga output LLM → dirender lewat Markdown aman yang sama. */}
        <AnswerMarkdown text={payload.summary} className="text-sm leading-6" />
        {long && !expanded && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-zinc-50 to-transparent dark:from-zinc-900"
          />
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.6875rem] text-zinc-500 dark:text-zinc-400">
          Dari {payload.chunksUsed} / {payload.totalChunks} chunk
          {sampled ? " (sampel merata awal–tengah–akhir dokumen)" : ""}
        </p>
        {long && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-accent-700 hover:underline dark:text-accent-300"
          >
            {expanded ? "Ringkas" : "Tampilkan semua"}
            <ChevronDown aria-hidden="true" className={cx("size-3.5 transition-transform", expanded && "rotate-180")} />
          </button>
        )}
      </div>
    </div>
  );
}
