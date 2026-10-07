import { AppShell } from "./components/AppShell";

// Halaman utama ("/"). Folder "(ui)" adalah route group: hanya untuk
// organisasi file, tidak muncul di URL.
//
// Page ini sengaja Server Component yang statis (tidak membaca cookies/headers),
// jadi dengan cacheComponents Next.js bisa me-prerender shell-nya saat build
// dan menyajikannya instan. Semua data per-sesi (status passcode, dokumen,
// chat) diambil di browser oleh AppShell lewat API route — cookie sesi sudah
// dipasang lebih dulu oleh proxy.ts saat halaman ini diminta.
export default function HomePage() {
  return <AppShell />;
}
