"use client";

import { CircleAlert, FileCode, FileText, FileType, RotateCcw, Trash, X } from "lucide-react";
import { useState, type RefObject } from "react";
import { fileKind, formatBytes, formatRelativeTime } from "@/lib/client/format";
import { MAX_FILES_PER_SESSION } from "@/lib/config";
import type { DocumentDTO } from "@/lib/types";
import type { DocumentsState, UploadItem } from "../hooks/useDocuments";
import { useNow } from "../hooks/useNow";
import { ConfirmDialog } from "./ConfirmDialog";
import { UploadDropzone } from "./UploadDropzone";
import { Button, IconButton, Spinner, StatusBadge, cx } from "./ui";

type Props = {
  state: DocumentsState;
  fileInputRef: RefObject<HTMLInputElement | null>;
};

export function DocumentList({ state, fileInputRef }: Props) {
  const { documents, loadError, uploads } = state;
  const [pendingDelete, setPendingDelete] = useState<DocumentDTO | null>(null);
  // Satu "jam" bersama untuk label "5 mnt lalu" di semua baris (bukan 1 timer per baris).
  const now = useNow(30_000);

  const isLoading = documents === null && loadError === null;
  const isEmpty = documents !== null && documents.length === 0 && uploads.length === 0;
  const activeUploads = uploads.filter((item) => item.status === "uploading").length;
  const usedSlots = (documents?.length ?? 0) + activeUploads;
  const isFull = usedSlots >= MAX_FILES_PER_SESSION;

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    void state.removeDocument(id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-4 pb-3 sm:px-5">
        <h2 className="text-sm font-semibold tracking-tight">Dokumen</h2>
        <span
          className="rounded-full bg-zinc-100 px-2 py-0.5 text-[0.6875rem] font-medium text-zinc-600 tabular-nums dark:bg-zinc-800 dark:text-zinc-400"
          title={`Maksimal ${MAX_FILES_PER_SESSION} dokumen per sesi`}
        >
          {documents?.length ?? 0}/{MAX_FILES_PER_SESSION}
        </span>
      </div>

      {!isEmpty && (
        <div className="px-4 sm:px-5">
          <UploadDropzone variant="compact" disabled={isFull || isLoading} onFiles={state.addFiles} inputRef={fileInputRef} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6 scroll-thin sm:px-5">
        {isLoading ? (
          <DocumentSkeletonList />
        ) : documents === null ? (
          <LoadError message={loadError ?? "Gagal memuat daftar dokumen."} onRetry={state.retryLoad} />
        ) : isEmpty ? (
          <UploadDropzone variant="hero" disabled={false} onFiles={state.addFiles} inputRef={fileInputRef} />
        ) : (
          <>
            {loadError && (
              <p role="status" className="mb-3 flex items-center gap-1.5 text-[0.6875rem] text-zinc-500">
                <Spinner className="size-3" />
                Gagal memperbarui status, mencoba lagi…
              </p>
            )}
            <ul className="space-y-2.5" aria-label="Daftar dokumen">
              {uploads.map((item) => (
                <UploadRow
                  key={item.localId}
                  item={item}
                  onCancel={() => state.cancelUpload(item.localId)}
                  onRetry={() => state.retryUpload(item.localId)}
                  onDismiss={() => state.dismissUpload(item.localId)}
                />
              ))}
              {documents.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  now={now}
                  deleting={state.deletingIds.has(doc.id)}
                  error={state.rowErrors[doc.id]}
                  onDelete={() => setPendingDelete(doc)}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Hapus dokumen?"
        description={
          <>
            <span className="font-medium break-all text-zinc-900 dark:text-zinc-100">{pendingDelete?.filename}</span>{" "}
            beserta semua potongan (chunk) dan embedding-nya akan dihapus permanen dari storage &amp; database.
          </>
        }
        confirmLabel="Hapus"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

const KIND_ICONS = { PDF: FileText, MD: FileCode, TXT: FileType, FILE: FileText } as const;

function FileTile({ filename, mimeType, muted }: { filename: string; mimeType?: string; muted?: boolean }) {
  const kind = fileKind(filename, mimeType);
  const Icon = KIND_ICONS[kind];
  return (
    <span
      aria-hidden="true"
      className={cx(
        "relative grid size-10 shrink-0 place-items-center rounded-lg ring-1 ring-inset",
        muted
          ? "bg-zinc-50 text-zinc-400 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-500 dark:ring-zinc-700/60"
          : "bg-zinc-50 text-zinc-600 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700",
      )}
    >
      <Icon className="size-4.5" />
      <span className="absolute -bottom-1.5 rounded bg-white px-1 text-[0.5625rem] leading-3.5 font-semibold tracking-wide text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-700">
        {kind}
      </span>
    </span>
  );
}

const ROW_CLASS =
  "animate-message-in rounded-xl border bg-white p-3 shadow-xs transition-colors dark:bg-zinc-900";

function DocumentRow({
  doc,
  now,
  deleting,
  error,
  onDelete,
}: {
  doc: DocumentDTO;
  now: number;
  deleting: boolean;
  error: string | undefined;
  onDelete: () => void;
}) {
  const meta = [
    formatBytes(doc.sizeBytes),
    doc.status === "ready" ? `${doc.chunkCount} chunk` : null,
    formatRelativeTime(doc.createdAt, now),
  ].filter(Boolean);

  return (
    <li
      className={cx(
        ROW_CLASS,
        doc.status === "failed"
          ? "border-red-200 dark:border-red-500/25"
          : "border-zinc-200 dark:border-zinc-800",
        deleting && "opacity-60",
      )}
      aria-busy={deleting || doc.status === "processing"}
    >
      <div className="flex items-start gap-3">
        <FileTile filename={doc.filename} mimeType={doc.mimeType} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={doc.filename}>
            {doc.filename}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge status={doc.status} />
            <span className="text-[0.6875rem] text-zinc-500 tabular-nums dark:text-zinc-400">{meta.join(" · ")}</span>
          </div>
        </div>
        {deleting ? (
          <span className="grid size-8 place-items-center text-zinc-400" role="status" aria-label="Menghapus…">
            <Spinner />
          </span>
        ) : (
          <IconButton
            label={`Hapus ${doc.filename}`}
            icon={Trash}
            onClick={onDelete}
            className="-mt-0.5 -mr-1 size-8 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
          />
        )}
      </div>

      {doc.status === "processing" && (
        <div className="mt-3 space-y-1.5">
          <div className="skeleton h-1.5 w-full" />
          <p className="text-[0.6875rem] text-zinc-500 dark:text-zinc-400">
            Mengekstrak teks, memotong (chunk), &amp; membuat embedding…
          </p>
        </div>
      )}

      {doc.status === "failed" && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-800 dark:bg-red-500/10 dark:text-red-200">
          <p>{doc.errorMessage ?? "Dokumen gagal diproses."}</p>
          <p className="mt-1 text-red-700/80 dark:text-red-300/70">
            Hapus dokumen ini lalu upload ulang (mis. versi PDF yang teksnya bisa diseleksi).
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2.5 flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {error}{" "}
            <button type="button" onClick={onDelete} className="font-medium underline underline-offset-2">
              Coba hapus lagi
            </button>
          </span>
        </p>
      )}
    </li>
  );
}

function UploadRow({
  item,
  onCancel,
  onRetry,
  onDismiss,
}: {
  item: UploadItem;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const percent = Math.round(item.progress * 100);
  const uploading = item.status === "uploading";
  // Semua byte sudah terkirim tapi respons belum datang = server sedang memvalidasi & menyimpan.
  const waitingServer = uploading && item.progress >= 1;

  return (
    <li
      className={cx(
        ROW_CLASS,
        uploading ? "border-zinc-200 dark:border-zinc-800" : "border-red-200 dark:border-red-500/25",
      )}
      aria-busy={uploading}
    >
      <div className="flex items-start gap-3">
        <FileTile filename={item.file.name} muted />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={item.file.name}>
            {item.file.name}
          </p>
          <p className="mt-1 text-[0.6875rem] text-zinc-500 tabular-nums dark:text-zinc-400">
            {uploading
              ? waitingServer
                ? "Memvalidasi file di server…"
                : `Mengunggah… ${percent}% · ${formatBytes(item.file.size)}`
              : `Upload gagal · ${formatBytes(item.file.size)}`}
          </p>
        </div>
        <IconButton
          label={uploading ? `Batalkan upload ${item.file.name}` : `Tutup pesan error ${item.file.name}`}
          icon={X}
          onClick={uploading ? onCancel : onDismiss}
          className="-mt-0.5 -mr-1 size-8"
        />
      </div>

      {uploading ? (
        <div
          role="progressbar"
          aria-label={`Progres upload ${item.file.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
        >
          {waitingServer ? (
            <div className="skeleton h-full w-full rounded-full" />
          ) : (
            <div
              className="h-full rounded-full bg-accent-500 transition-[width] duration-200 ease-out"
              style={{ width: `${Math.max(percent, 2)}%` }}
            />
          )}
        </div>
      ) : (
        <div role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 dark:bg-red-500/10">
          <p className="flex items-start gap-1.5 text-xs leading-5 text-red-800 dark:text-red-200">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {item.error?.message ?? "Upload gagal."}
          </p>
          {item.error?.retryable && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
              <RotateCcw aria-hidden="true" />
              Coba lagi
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function DocumentSkeletonList() {
  return (
    <ul className="space-y-2.5" aria-label="Memuat dokumen" aria-busy="true">
      {[0, 1, 2].map((key) => (
        <li key={key} className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="skeleton size-10 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="skeleton h-3 w-3/4" />
            <div className="skeleton h-2.5 w-1/2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-2xl border border-zinc-200 px-6 py-10 text-center dark:border-zinc-800">
      <span className="grid size-11 place-items-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
        <CircleAlert aria-hidden="true" className="size-5" />
      </span>
      <p className="mt-4 text-sm font-semibold">Daftar dokumen gagal dimuat</p>
      <p className="mt-1 max-w-xs text-xs leading-5 text-zinc-500 dark:text-zinc-400">{message}</p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
        Coba lagi
      </Button>
    </div>
  );
}
