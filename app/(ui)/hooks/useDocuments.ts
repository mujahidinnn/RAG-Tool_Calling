"use client";

// State daftar dokumen + upload + hapus, dipisah dari komponen supaya
// DocumentList cukup fokus ke tampilan.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiClientError,
  deleteDocument,
  isAbortError,
  isApiClientError,
  listDocuments,
  uploadDocument,
} from "@/lib/client/api";
import { ALLOWED_EXTENSIONS, MAX_FILE_BYTES, MAX_FILES_PER_SESSION } from "@/lib/config";
import type { DocumentDTO } from "@/lib/types";

/** Selama ada dokumen "processing", daftar di-refresh tiap 2 detik. */
const POLL_INTERVAL_MS = 2000;

export type UploadItem = {
  localId: string;
  file: File;
  /** 0..1 — byte yang sudah terkirim ke server. */
  progress: number;
  status: "uploading" | "error";
  error: { message: string; retryable: boolean } | null;
};

type LoadResult = { ok: true; documents: DocumentDTO[] } | { ok: false; error: unknown };

/** Fetch saja (tanpa setState) — hasilnya diterapkan oleh pemanggil. */
async function loadDocuments(): Promise<LoadResult> {
  try {
    return { ok: true, documents: await listDocuments() };
  } catch (error) {
    return { ok: false, error };
  }
}

function withoutKey(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const next = { ...record };
  delete next[key];
  return next;
}

let uploadCounter = 0;
function nextUploadId(): string {
  uploadCounter += 1;
  return `upload-${uploadCounter}`;
}

/**
 * Validasi cepat di browser — HANYA untuk UX (feedback instan tanpa
 * mengirim 5 MB lewat jaringan). Server tetap memvalidasi ulang semuanya:
 * ukuran dihitung dari byte aktual dan tipe dari ISI file, bukan nama.
 */
function validateLocally(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return "Tipe file tidak didukung. Hanya PDF, Markdown (.md), atau teks (.txt).";
  }
  if (file.size > MAX_FILE_BYTES) return "File melebihi 5 MB.";
  if (file.size === 0) return "File kosong.";
  return null;
}

// Error yang pasti terulang kalau file yang SAMA dikirim lagi → tanpa tombol retry.
const NON_RETRYABLE_UPLOAD_CODES = new Set(["file_too_large", "unsupported_type", "empty_file"]);

function toUploadError(err: unknown): { message: string; retryable: boolean } {
  if (isApiClientError(err)) {
    return { message: err.message, retryable: !NON_RETRYABLE_UPLOAD_CODES.has(err.code) };
  }
  return { message: "Upload gagal karena kesalahan tak terduga.", retryable: true };
}

export function useDocuments({ onUnauthorized }: { onUnauthorized: () => void }) {
  /** null = belum pernah berhasil dimuat. */
  const [documents, setDocuments] = useState<DocumentDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});

  const controllers = useRef(new Map<string, AbortController>());
  const refreshInFlight = useRef(false);
  // Naik tiap kali daftar diubah lokal (upload selesai / dokumen dihapus).
  // Hasil fetch yang DIMULAI sebelum perubahan itu sudah basi dan dibuang —
  // kalau tidak, polling bisa "menghidupkan lagi" dokumen yang baru dihapus.
  const localChanges = useRef(0);

  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (isApiClientError(err) && err.code === "unauthorized") {
        onUnauthorized();
        return true;
      }
      return false;
    },
    [onUnauthorized],
  );

  const applyLoad = useCallback(
    (result: LoadResult, changesAtStart: number) => {
      if (changesAtStart !== localChanges.current) return; // basi, tunggu polling berikutnya
      if (result.ok) {
        setDocuments(result.documents);
        setLoadError(null);
        return;
      }
      if (handleAuthError(result.error)) return;
      // Kalau daftar sudah pernah tampil, gagal 1x polling cukup dicoba lagi di
      // tick berikutnya (UI hanya menampilkan peringatan kecil).
      setLoadError(result.error instanceof Error ? result.error.message : "Gagal memuat daftar dokumen.");
    },
    [handleAuthError],
  );

  const refresh = useCallback(async (): Promise<void> => {
    // Polling bisa menumpuk kalau server lambat — lewati kalau masih ada request berjalan.
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const changesAtStart = localChanges.current;
    const result = await loadDocuments();
    refreshInFlight.current = false;
    applyLoad(result, changesAtStart);
  }, [applyLoad]);

  // Muat pertama kali. `cancelled` mencegah update state setelah unmount
  // (mis. StrictMode di dev me-mount effect 2x).
  useEffect(() => {
    let cancelled = false;
    const changesAtStart = localChanges.current;
    void loadDocuments().then((result) => {
      if (!cancelled) applyLoad(result, changesAtStart);
    });
    return () => {
      cancelled = true;
    };
  }, [applyLoad]);

  // Polling selama ada dokumen yang masih diproses (extract → chunk → embed).
  const hasProcessing = documents?.some((doc) => doc.status === "processing") ?? false;
  useEffect(() => {
    if (!hasProcessing) return;
    const id = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [hasProcessing, refresh]);

  // Batalkan upload yang masih berjalan saat komponen dilepas (mis. logout).
  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, []);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    void refresh();
  }, [refresh]);

  const startUpload = useCallback(
    (localId: string, file: File) => {
      const controller = new AbortController();
      controllers.current.set(localId, controller);

      const patch = (changes: Partial<UploadItem>) =>
        setUploads((prev) => prev.map((item) => (item.localId === localId ? { ...item, ...changes } : item)));

      uploadDocument(file, (progress) => patch({ progress }), controller.signal)
        .then((doc) => {
          localChanges.current += 1;
          setUploads((prev) => prev.filter((item) => item.localId !== localId));
          // Dokumen baru (status "processing") langsung tampil; polling mengambil alih.
          setDocuments((prev) => [doc, ...(prev ?? []).filter((existing) => existing.id !== doc.id)]);
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) {
            setUploads((prev) => prev.filter((item) => item.localId !== localId));
            return;
          }
          handleAuthError(err);
          patch({ status: "error", error: toUploadError(err) });
        })
        .finally(() => controllers.current.delete(localId));
    },
    [handleAuthError],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      const activeUploads = uploads.filter((item) => item.status === "uploading").length;
      let freeSlots = MAX_FILES_PER_SESSION - (documents?.length ?? 0) - activeUploads;

      const items: UploadItem[] = files.map((file) => {
        let message = validateLocally(file);
        let retryable = false;
        if (!message && freeSlots <= 0) {
          message = `Maksimal ${MAX_FILES_PER_SESSION} file per sesi. Hapus salah satu dokumen dulu.`;
          retryable = true; // bisa dicoba lagi setelah user menghapus dokumen
        }
        if (message) {
          return { localId: nextUploadId(), file, progress: 0, status: "error", error: { message, retryable } };
        }
        freeSlots -= 1;
        return { localId: nextUploadId(), file, progress: 0, status: "uploading", error: null };
      });

      setUploads((prev) => [...items, ...prev]);
      for (const item of items) {
        if (item.status === "uploading") startUpload(item.localId, item.file);
      }
    },
    [documents, uploads, startUpload],
  );

  const retryUpload = useCallback(
    (localId: string) => {
      const item = uploads.find((upload) => upload.localId === localId);
      if (!item) return;
      setUploads((prev) =>
        prev.map((upload) =>
          upload.localId === localId ? { ...upload, status: "uploading", progress: 0, error: null } : upload,
        ),
      );
      // Kirim ulang File yang SAMA (masih tersimpan di memori browser).
      startUpload(localId, item.file);
    },
    [uploads, startUpload],
  );

  const cancelUpload = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
  }, []);

  const dismissUpload = useCallback((localId: string) => {
    setUploads((prev) => prev.filter((item) => item.localId !== localId));
  }, []);

  const removeDocument = useCallback(
    async (id: string): Promise<void> => {
      setDeletingIds((prev) => new Set(prev).add(id));
      setRowErrors((prev) => withoutKey(prev, id));
      try {
        await deleteDocument(id);
        localChanges.current += 1;
        setDocuments((prev) => prev?.filter((doc) => doc.id !== id) ?? prev);
      } catch (err) {
        if (handleAuthError(err)) return;
        if (err instanceof ApiClientError && err.code === "not_found") {
          // Sudah tidak ada di server (mis. terhapus otomatis setelah 24 jam).
          localChanges.current += 1;
          setDocuments((prev) => prev?.filter((doc) => doc.id !== id) ?? prev);
          return;
        }
        const message = err instanceof Error ? err.message : "Gagal menghapus dokumen.";
        setRowErrors((prev) => ({ ...prev, [id]: message }));
      } finally {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [handleAuthError],
  );

  return {
    documents,
    loadError,
    retryLoad,
    uploads,
    addFiles,
    retryUpload,
    cancelUpload,
    dismissUpload,
    deletingIds,
    rowErrors,
    removeDocument,
  };
}

export type DocumentsState = ReturnType<typeof useDocuments>;
