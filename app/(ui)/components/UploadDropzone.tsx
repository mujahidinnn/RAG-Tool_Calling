"use client";

import { CloudUpload, FileText, FileType, FileUp, ShieldAlert, Upload } from "lucide-react";
import { useEffect, useState, type ChangeEvent, type DragEvent, type RefObject } from "react";
import { ALLOWED_EXTENSIONS, DOCUMENT_TTL_HOURS, MAX_FILE_BYTES, MAX_FILES_PER_SESSION } from "@/lib/config";
import { formatBytes } from "@/lib/client/format";
import { Button, cx } from "./ui";

type Props = {
  /** "hero" = empty state besar (belum ada dokumen); "compact" = baris kecil di atas daftar. */
  variant: "hero" | "compact";
  disabled: boolean;
  onFiles: (files: File[]) => void;
  /** Dipakai AppShell untuk membuka file picker dari CTA di panel chat. */
  inputRef: RefObject<HTMLInputElement | null>;
};

// `accept` hanya memfilter dialog pilih file (UX); validasi sebenarnya di server.
const ACCEPT = [...ALLOWED_EXTENSIONS, "application/pdf", "text/markdown", "text/plain"].join(",");
const LIMITS_TEXT = `PDF, MD, atau TXT · maks ${formatBytes(MAX_FILE_BYTES)} · maks ${MAX_FILES_PER_SESSION} file`;

function hasFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

export function UploadDropzone({ variant, disabled, onFiles, inputRef }: Props) {
  const [dragDepth, setDragDepth] = useState(0);
  const dragging = dragDepth > 0 && !disabled;

  // File yang dilepas SEDIKIT di luar dropzone akan dibuka browser sebagai
  // halaman baru (state chat hilang). Cegah perilaku default itu di window.
  useEffect(() => {
    const preventFileDrop = (event: globalThis.DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    window.addEventListener("dragover", preventFileDrop);
    window.addEventListener("drop", preventFileDrop);
    return () => {
      window.removeEventListener("dragover", preventFileDrop);
      window.removeEventListener("drop", preventFileDrop);
    };
  }, []);

  const openPicker = () => inputRef.current?.click();

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Reset supaya memilih file yang sama lagi tetap memicu onChange.
    event.target.value = "";
    if (files.length > 0) onFiles(files);
  };

  // dragenter/dragleave juga terpicu saat kursor melewati elemen anak →
  // pakai penghitung kedalaman supaya highlight tidak berkedip.
  const dropHandlers = {
    onDragEnter: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragDepth((depth) => depth + 1);
    },
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    },
    onDragLeave: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      setDragDepth((depth) => Math.max(0, depth - 1));
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDragDepth(0);
      if (disabled) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
  };

  return (
    <div className="space-y-2.5">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleChange}
        disabled={disabled}
      />

      {variant === "hero" ? (
        <div
          {...dropHandlers}
          className={cx(
            "flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors duration-200",
            dragging
              ? "border-accent-400 bg-accent-50/70 dark:border-accent-400/60 dark:bg-accent-500/10"
              : "border-zinc-300 bg-white/60 dark:border-zinc-700 dark:bg-zinc-900/40",
          )}
        >
          <EmptyIllustration />
          <h3 className="mt-6 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Belum ada dokumen</h3>
          <p className="mt-1.5 max-w-[17rem] text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Upload dokumen lalu tanyakan isinya. Setiap jawaban disertai sitasi ke potongan dokumen aslinya.
          </p>
          <Button variant="primary" className="mt-5" onClick={openPicker} disabled={disabled}>
            <Upload aria-hidden="true" />
            Upload dokumen
          </Button>
          <p className="mt-3 text-[0.6875rem] text-zinc-500 dark:text-zinc-400">
            <span className="hidden sm:inline">atau tarik &amp; lepas file ke sini · </span>
            {LIMITS_TEXT}
          </p>
        </div>
      ) : (
        <button
          type="button"
          {...dropHandlers}
          onClick={openPicker}
          disabled={disabled}
          className={cx(
            "group flex w-full items-center gap-3 rounded-xl border border-dashed px-3 py-2.5 text-left transition-colors duration-200 disabled:cursor-not-allowed",
            dragging
              ? "border-accent-400 bg-accent-50/70 dark:border-accent-400/60 dark:bg-accent-500/10"
              : "border-zinc-300 bg-white hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/60 dark:hover:border-zinc-600 dark:hover:bg-zinc-900",
          )}
        >
          <span
            className={cx(
              "grid size-9 shrink-0 place-items-center rounded-lg transition-colors",
              dragging
                ? "bg-accent-100 text-accent-700 dark:bg-accent-500/20 dark:text-accent-300"
                : "bg-zinc-100 text-zinc-500 group-hover:text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:group-hover:text-zinc-200",
            )}
          >
            <CloudUpload aria-hidden="true" className="size-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
              {disabled
                ? `Batas ${MAX_FILES_PER_SESSION} dokumen tercapai`
                : dragging
                  ? "Lepas untuk mengupload"
                  : "Upload dokumen"}
            </span>
            <span className="block truncate text-[0.6875rem] text-zinc-500 dark:text-zinc-400">
              {disabled ? "Hapus salah satu dokumen untuk upload lagi." : LIMITS_TEXT}
            </span>
          </span>
        </button>
      )}

      {/* Disclaimer privasi WAJIB terlihat di area upload (spec §2). */}
      <p className="flex gap-2 rounded-lg bg-amber-50/80 px-3 py-2 text-[0.6875rem] leading-4 text-amber-900 ring-1 ring-amber-600/10 ring-inset dark:bg-amber-400/5 dark:text-amber-200/90 dark:ring-amber-400/15">
        <ShieldAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span>
          Jangan upload dokumen berisi data pribadi/sensitif — ini demo publik. Dokumen otomatis dihapus setelah{" "}
          {DOCUMENT_TTL_HOURS} jam.
        </span>
      </p>
    </div>
  );
}

/** Ilustrasi empty state: tumpukan dokumen dengan ikon upload di tengah. */
function EmptyIllustration() {
  const card =
    "absolute grid place-items-center rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800";
  return (
    <div aria-hidden="true" className="relative h-20 w-28">
      <div className={cx(card, "top-3 left-2 h-16 w-12 -rotate-12")}>
        <FileText className="size-5 text-zinc-400 dark:text-zinc-500" />
      </div>
      <div className={cx(card, "top-3 right-2 h-16 w-12 rotate-12")}>
        <FileType className="size-5 text-zinc-400 dark:text-zinc-500" />
      </div>
      <div className={cx(card, "top-0 left-1/2 h-[4.5rem] w-14 -translate-x-1/2 shadow-md")}>
        <FileUp className="size-6 text-accent-600 dark:text-accent-400" />
      </div>
    </div>
  );
}
