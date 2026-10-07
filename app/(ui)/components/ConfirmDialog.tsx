"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./ui";

type Props = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Dialog konfirmasi berbasis elemen <dialog> native. `showModal()` memberi
 * gratis: focus trap, tombol Esc, background jadi inert, dan backdrop —
 * hal-hal yang sering salah kalau dibuat manual dengan div.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      // Esc / dialog.close() → event "close": sinkronkan state parent.
      onClose={onCancel}
      // Klik di backdrop (target = elemen dialog itu sendiri) = batal.
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-950/40 open:animate-message-in dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <div className="p-5">
        <div className="flex gap-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
            <TriangleAlert aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-[0.9375rem] font-semibold">
              {title}
            </h2>
            <div id={descriptionId} className="mt-1.5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              {description}
            </div>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {/* Fokus awal di "Batal": untuk aksi destruktif, Enter tidak boleh langsung menghapus. */}
          <Button variant="secondary" onClick={onCancel} autoFocus>
            Batal
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              // Tutup DULU (sinkron) baru onConfirm: halaman sudah tidak inert,
              // jadi onConfirm boleh memindah fokus atau membuka file picker.
              ref.current?.close();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
