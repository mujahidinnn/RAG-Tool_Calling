// Primitive UI kecil yang dipakai ulang (tombol, spinner, badge status).
// Sengaja tanpa library komponen: cukup beberapa variasi kelas Tailwind
// supaya tampilan konsisten di semua panel.

import type { LucideIcon } from "lucide-react";
import { CircleAlert, CircleCheck, FileSearch, LoaderCircle } from "lucide-react";
import type { ComponentProps } from "react";
import type { DocumentStatus } from "@/lib/types";

/** Gabungkan className, abaikan nilai falsy. */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-zinc-900 text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
  accent: "bg-accent-600 text-white shadow-sm hover:bg-accent-500 dark:bg-accent-500 dark:hover:bg-accent-400",
  secondary:
    "border border-zinc-200 bg-white text-zinc-800 shadow-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800",
  ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-500",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs [&_svg]:size-3.5",
  md: "h-10 px-4 text-sm [&_svg]:size-4",
};

type ButtonProps = ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize };

export function Button({ variant = "secondary", size = "md", className, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...props}
    />
  );
}

type IconButtonProps = Omit<ComponentProps<"button">, "children" | "aria-label"> & {
  /** WAJIB: tombol tanpa teks harus punya nama yang dibaca screen reader. */
  label: string;
  icon: LucideIcon;
  size?: "sm" | "md";
};

/** Tombol ikon saja. `label` dipakai sebagai aria-label sekaligus tooltip. */
export function IconButton({ label, icon: Icon, size = "md", className, type = "button", ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "inline-grid shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors duration-150 hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
        size === "sm" ? "size-7" : "size-9",
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className={size === "sm" ? "size-3.5" : "size-4"} />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={cx("animate-spin", className ?? "size-4")} />;
}

/** Logo aplikasi: dokumen + kaca pembesar = "cari di dokumen" (RAG). */
export function BrandMark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid shrink-0 place-items-center bg-linear-to-br from-accent-500 to-accent-700 text-white shadow-sm ring-1 ring-black/5 ring-inset",
        size === "lg" ? "size-12 rounded-2xl" : "size-8 rounded-lg",
      )}
    >
      <FileSearch className={size === "lg" ? "size-6" : "size-4"} />
    </span>
  );
}

const STATUS_STYLES: Record<DocumentStatus, { label: string; icon: LucideIcon; className: string }> = {
  processing: {
    label: "Memproses",
    icon: LoaderCircle,
    className: "bg-amber-50 text-amber-700 ring-amber-600/15 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/20",
  },
  ready: {
    label: "Siap",
    icon: CircleCheck,
    className:
      "bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  },
  failed: {
    label: "Gagal",
    icon: CircleAlert,
    className: "bg-red-50 text-red-700 ring-red-600/15 dark:bg-red-400/10 dark:text-red-300 dark:ring-red-400/20",
  },
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  const style = STATUS_STYLES[status];
  const Icon = style.icon;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset",
        style.className,
      )}
    >
      <Icon aria-hidden="true" className={cx("size-3", status === "processing" && "animate-spin")} />
      {style.label}
    </span>
  );
}
