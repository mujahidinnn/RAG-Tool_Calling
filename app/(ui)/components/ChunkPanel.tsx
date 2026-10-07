"use client";

import { FileText, Layers, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { Source } from "@/lib/types";
import { IconButton, cx } from "./ui";

/** Isi panel sumber: semua chunk hasil retrieval untuk 1 jawaban + chunk yang sedang difokuskan. */
export type SourcesView = {
  sources: Source[];
  /** Nomor sitasi per Source.id — hanya chunk yang benar-benar dikutip jawaban. */
  citedNumbers: Readonly<Record<string, number>>;
  focus:
    | { kind: "source"; sourceId: string }
    | { kind: "unverified"; filename: string; chunkIndex: number; number: number }
    | null;
};

type Props = {
  view: SourcesView | null;
  onClose: () => void;
};

/**
 * Panel samping (bottom sheet di HP) yang menampilkan potongan dokumen ASLI.
 *
 * KEAMANAN: isi chunk berasal dari file upload user = input tidak tepercaya
 * (bisa berisi `<script>`, HTML, atau teks prompt injection). Karena itu
 * dirender sebagai TEKS biasa ({source.content}) — React meng-escape-nya.
 * Jangan pernah memakai dangerouslySetInnerHTML atau renderer Markdown di sini.
 */
export function ChunkPanel({ view, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focusedRef = useRef<HTMLLIElement>(null);
  const titleId = useId();
  const open = view !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Gulir ke chunk yang diklik supaya langsung terlihat (panel bisa berisi 5 chunk panjang).
  useEffect(() => {
    if (view?.focus?.kind === "source") focusedRef.current?.scrollIntoView({ block: "start" });
  }, [view]);

  const focusedId = view?.focus?.kind === "source" ? view.focus.sourceId : null;
  const unverified = view?.focus?.kind === "unverified" ? view.focus : null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cx(
        "m-0 max-h-none max-w-none border-0 bg-transparent p-0 text-zinc-900 backdrop:bg-zinc-950/40 dark:text-zinc-100",
        // HP: bottom sheet setinggi 85% layar. ≥sm: drawer di kanan setinggi layar.
        "fixed inset-x-0 top-auto bottom-0 h-[85dvh] w-full",
        "sm:inset-y-0 sm:right-0 sm:left-auto sm:h-dvh sm:w-[30rem]",
        "open:animate-sheet-in sm:open:animate-drawer-in",
      )}
    >
      {view && (
        <div className="flex h-full flex-col overflow-hidden rounded-t-2xl border-zinc-200 bg-white shadow-2xl sm:rounded-none sm:border-l dark:border-zinc-800 dark:bg-zinc-900">
          {/* Pegangan visual bottom sheet (dekoratif). */}
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-zinc-300 sm:hidden dark:bg-zinc-700" />
          <header className="flex items-start gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              <Layers aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-sm font-semibold">
                Sumber jawaban
              </h2>
              <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {view.sources.length} potongan paling relevan yang dikirim ke model, urut dari yang paling mirip.
              </p>
            </div>
            <IconButton label="Tutup panel sumber" icon={X} onClick={onClose} className="-mt-1 -mr-2" />
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scroll-thin">
            {unverified && (
              <div
                role="note"
                className="mb-4 flex gap-2.5 rounded-xl border border-dashed border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/5 dark:text-amber-200"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <p>
                  <span className="font-semibold">Sitasi [{unverified.number}] tidak terverifikasi.</span> Model
                  menyebut <span className="font-mono break-all">[{unverified.filename}, chunk #{unverified.chunkIndex}]</span>,
                  tapi potongan itu tidak ada di hasil pencarian untuk jawaban ini. Periksa ulang klaim yang memakai
                  sitasi ini.
                </p>
              </div>
            )}

            {view.sources.length === 0 ? (
              <p className="rounded-xl border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                Tidak ada potongan dokumen yang diambil untuk jawaban ini.
              </p>
            ) : (
              <ol className="space-y-3">
                {view.sources.map((source) => {
                  const focused = source.id === focusedId;
                  const citedAs = view.citedNumbers[source.id];
                  return (
                    <li
                      key={source.id}
                      ref={focused ? focusedRef : undefined}
                      aria-current={focused ? "true" : undefined}
                      className={cx(
                        "scroll-mt-2 rounded-xl border p-3.5 transition-colors",
                        focused
                          ? "border-accent-300 bg-accent-50/50 ring-4 ring-accent-500/10 dark:border-accent-400/40 dark:bg-accent-400/5"
                          : "border-zinc-200 dark:border-zinc-800",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <FileText aria-hidden="true" className="size-3.5 shrink-0 text-zinc-400" />
                        <span className="min-w-0 truncate font-medium text-zinc-800 dark:text-zinc-200" title={source.filename}>
                          {source.filename}
                        </span>
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.6875rem] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                          chunk #{source.chunkIndex}
                        </span>
                        <span className="ml-auto text-[0.6875rem] text-zinc-500 tabular-nums dark:text-zinc-400">
                          {Math.round(source.similarity * 100)}% mirip
                        </span>
                      </div>
                      {citedAs !== undefined && (
                        <p className="mt-1.5 text-[0.6875rem] font-medium text-accent-700 dark:text-accent-300">
                          Dikutip sebagai sumber [{citedAs}]
                        </p>
                      )}
                      {/* TEKS biasa, bukan HTML — lihat catatan keamanan di atas. */}
                      <p className="mt-2.5 text-[0.8125rem] leading-6 break-words whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
                        {source.content}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          <footer className="flex items-center gap-1.5 border-t border-zinc-200 px-5 py-3 text-[0.6875rem] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
            Isi dokumen ditampilkan sebagai teks biasa, tidak pernah dirender sebagai HTML.
          </footer>
        </div>
      )}
    </dialog>
  );
}
