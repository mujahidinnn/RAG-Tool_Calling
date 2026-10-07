import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Docs Assistant",
  description:
    "Tanya jawab isi dokumen (PDF, Markdown, TXT) dengan RAG: jawaban streaming, sitasi ke potongan dokumen asli, tool calling, dan pilihan LLM Claude atau GPT.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
  // Di HP, keyboard virtual mengecilkan layout (bukan menutupi) → kotak chat
  // di bawah tetap terlihat saat mengetik.
  interactiveWidget: "resizes-content",
};

// Font: system font stack (font-sans bawaan Tailwind) — sengaja tanpa
// next/font/google supaya build tidak bergantung pada akses ke Google Fonts.
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="id">
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
