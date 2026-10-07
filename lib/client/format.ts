// Helper format tampilan (angka, ukuran file, waktu relatif) — locale Indonesia.
// PURE: tanpa React/DOM. Waktu "sekarang" selalu dioper dari luar supaya
// fungsi tetap deterministik (dan tidak memanggil Date.now() saat render).

const numberFormat = new Intl.NumberFormat("id-ID");
const decimalFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const relativeFormat = new Intl.RelativeTimeFormat("id-ID", { numeric: "auto", style: "short" });

/** 1234 → "1.234" */
export function formatNumber(n: number): string {
  return numberFormat.format(n);
}

/** 1536000 → "1,5 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${decimalFormat.format(bytes / 1024)} KB`;
  return `${decimalFormat.format(bytes / (1024 * 1024))} MB`;
}

/** Waktu relatif singkat: "baru saja", "5 mnt lalu", "2 jam lalu". */
export function formatRelativeTime(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  if (Math.abs(seconds) < 45) return "baru saja";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour");
  return relativeFormat.format(Math.round(hours / 24), "day");
}

/** Label jenis file pendek untuk ikon/badge: "PDF" | "MD" | "TXT". */
export function fileKind(filename: string, mimeType?: string): "PDF" | "MD" | "TXT" | "FILE" {
  const lower = filename.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "PDF";
  if (mimeType === "text/markdown" || lower.endsWith(".md")) return "MD";
  if (mimeType === "text/plain" || lower.endsWith(".txt")) return "TXT";
  return "FILE";
}
