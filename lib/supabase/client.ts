import "server-only";

// Client Supabase untuk SERVER saja (API route, after(), tools).
// Memakai service role key yang BYPASS Row Level Security — karena itu:
// * file ini `server-only` (build gagal kalau sampai ke bundle client);
// * setiap query dokumen/chunk WAJIB memfilter `session_id` sendiri —
//   database tidak akan menyaring untuk kita.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

let client: SupabaseClient | null = null;

/** Singleton lazy: dibuat saat pertama dipakai, bukan saat import (aman untuk `next build`). */
export function getSupabase(): SupabaseClient {
  if (client === null) {
    const env = getServerEnv();
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: {
        // Tidak ada login user Supabase di app ini; jangan simpan/refresh
        // sesi apa pun di memori server (bisa tercampur antar request).
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}
