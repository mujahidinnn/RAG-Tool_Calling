// Dipanggil Next.js SEKALI saat server (atau instance serverless) mulai.
// Env dibaca di sini supaya peringatan konfigurasi (DEMO_PASSCODE pendek,
// DAILY_BUDGET_USD terlalu kecil) muncul di log saat start — bukan baru saat
// request pertama, ketika operator sudah tidak melihat log.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getServerEnv } = await import("@/lib/env");
  try {
    getServerEnv();
  } catch {
    // Env belum lengkap: server tetap start, dan setiap request API membalas
    // config_error berisi nama env yang kurang (lib/server/http.ts).
  }
}
