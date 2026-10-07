-- =============================================================================
-- AI Docs Assistant — skema database (Supabase: Postgres + pgvector + Storage)
-- =============================================================================
-- Cara pakai: buka Supabase Dashboard → SQL Editor → paste seluruh file → Run.
-- (atau: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/supabase/schema.sql)
--
-- Sifat file ini:
-- * IDEMPOTENT — aman dijalankan ulang (create ... if not exists, create or
--   replace function, on conflict do nothing). Catatan: kalau tabel SUDAH ada
--   dari versi skema lain, constraint baru tidak ditambahkan otomatis.
-- * ATOMIC — dibungkus 1 transaksi: kalau ada yang gagal, tidak ada yang
--   setengah jadi.
-- * PORTABLE — jalan di Supabase DAN di Postgres 16 + pgvector biasa (untuk
--   belajar/test lokal). Bagian khusus Supabase (schema `storage`, role
--   anon/authenticated/service_role) dijaga dengan blok DO yang mengecek dulu.
--
-- Model keamanan: TIDAK ada akses langsung dari browser ke Supabase. Semua
-- query lewat API route Next.js memakai service role key (yang bypass RLS).
-- RLS tetap dinyalakan TANPA policy, supaya anon key publik (yang dimiliki
-- setiap project Supabase) tidak bisa membaca/menulis apa pun.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Extension pgvector
-- -----------------------------------------------------------------------------
-- Supabase menyarankan extension ditaruh di schema `extensions` (bukan public);
-- Postgres biasa tidak punya schema itu, jadi pakai default (public).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    create extension if not exists vector with schema extensions;
  else
    create extension if not exists vector;
  end if;
end
$$;

-- Supaya tipe `vector` & operator `<=>` ketemu di mana pun extension-nya
-- terpasang. Schema yang tidak ada di search_path diabaikan Postgres.
set local search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Helper: "hari ini" untuk budget harian
-- -----------------------------------------------------------------------------
-- Hari dihitung dalam UTC secara eksplisit, bukan `current_date` (yang ikut
-- timezone server/sesi). Dengan begini semua kode — reserve, record, cek
-- budget — selalu sepakat soal "hari ini". Budget reset jam 00:00 UTC
-- (= 07:00 WIB).
create or replace function public.usage_day()
returns date
language sql
stable
set search_path = public, extensions
as $$
  select (now() at time zone 'utc')::date;
$$;

-- -----------------------------------------------------------------------------
-- 2. Tabel
-- -----------------------------------------------------------------------------
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  -- 1 passcode demo dipakai banyak orang. Tanpa session_id, dokumen siapa pun
  -- bisa dibaca/ditanya orang lain. SEMUA query dokumen wajib filter kolom ini.
  session_id uuid not null,
  filename text not null,
  -- Sama dengan `id` (UUID dari server), BUKAN nama file asli user — nama asli
  -- bisa berisi `../`, karakter aneh, atau menimpa file orang lain.
  storage_path text not null,
  mime_type text not null,
  size_bytes int not null,
  status text not null default 'processing',
  -- Diisi kalau status = 'failed'; pesan siap tampil ke user.
  error_message text,
  created_at timestamptz not null default now(),
  constraint documents_status_check
    check (status in ('processing', 'ready', 'failed')),
  constraint documents_size_bytes_check check (size_bytes >= 0)
);

-- Daftar dokumen per sesi (urut terbaru) + cek jumlah dokumen per sesi.
-- Index komposit ini juga melayani filter `session_id = ...` saja.
create index if not exists documents_session_created_idx
  on public.documents (session_id, created_at desc);
-- Untuk job cleanup "hapus dokumen > 24 jam".
create index if not exists documents_created_at_idx
  on public.documents (created_at);

create table if not exists public.chunks (
  id uuid primary key default gen_random_uuid(),
  -- NOT NULL: chunk tanpa dokumen tidak punya arti (dan lolos dari filter sesi).
  -- ON DELETE CASCADE: hapus 1 dokumen = semua chunk-nya ikut terhapus.
  document_id uuid not null references public.documents (id) on delete cascade,
  chunk_index int not null,
  content text not null,
  -- Dimensi HARUS sama dengan model embedding (text-embedding-3-small = 1536)
  -- dan dengan EMBEDDING_DIMENSIONS di lib/config.ts. Embedding sengaja cuma
  -- 1 provider: kalau ikut multi-provider, dimensi vector beda-beda.
  -- NOT NULL: chunk selalu disimpan bersama embedding-nya.
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  constraint chunks_chunk_index_check check (chunk_index >= 0),
  -- Nomor sitasi "[file, chunk #n]" harus menunjuk tepat 1 chunk. Index unik
  -- ini (kolom pertama document_id) sekaligus jadi index untuk
  -- `where document_id = ...` dan JOIN — tidak perlu index terpisah.
  constraint chunks_document_chunk_unique unique (document_id, chunk_index)
);

-- Kenapa TIDAK ada index vector (ivfflat/hnsw) di sini?
-- * match_chunks selalu filter per sesi (maks 5 dokumen ≈ ratusan chunk), jadi
--   Postgres cukup scan EXACT chunk milik sesi itu lewat index
--   chunks_document_chunk_unique — hasil 100% akurat dan tetap cepat.
-- * Index ANN (approximate) mencari tetangga terdekat dari SELURUH tabel dulu,
--   baru difilter per sesi → bisa diam-diam mengembalikan < k hasil (atau 0)
--   walau sesi itu punya chunk yang relevan.
-- * ivfflat yang dibuat saat tabel masih kosong punya centroid jelek (recall
--   buruk) dan harus di-REINDEX setelah data terisi.
-- Kalau nanti skalanya besar (jutaan chunk, tanpa filter per sesi), baru
-- tambahkan HNSW — dan di pgvector >= 0.8 nyalakan iterative scan supaya
-- filter tidak memotong hasil:
--   create index if not exists chunks_embedding_hnsw_idx
--     on public.chunks using hnsw (embedding vector_cosine_ops);
--   -- per query/sesi: set hnsw.iterative_scan = relaxed_order;

create table if not exists public.usage_daily (
  day date primary key default public.usage_day(),
  tokens_used bigint not null default 0,
  cost_usd numeric not null default 0,
  constraint usage_daily_tokens_check check (tokens_used >= 0),
  constraint usage_daily_cost_check check (cost_usd >= 0)
);

comment on table public.documents is
  'Dokumen upload per sesi demo (session_id dari cookie httpOnly).';
comment on table public.chunks is
  'Potongan teks dokumen + embedding (pgvector) untuk RAG.';
comment on table public.usage_daily is
  'Pemakaian token & biaya global per hari (UTC) untuk daily cap demo publik.';

-- -----------------------------------------------------------------------------
-- 3. Row Level Security
-- -----------------------------------------------------------------------------
-- Nyala TANPA policy = role selain pemilik tabel & role BYPASSRLS
-- (service_role di Supabase) tidak bisa melihat/mengubah baris apa pun.
alter table public.documents enable row level security;
alter table public.chunks enable row level security;
alter table public.usage_daily enable row level security;

-- -----------------------------------------------------------------------------
-- 4. Functions (dipanggil dari server lewat supabase.rpc)
-- -----------------------------------------------------------------------------
-- Semua `security invoker` (jalan dengan hak pemanggil, bukan pemilik fungsi)
-- dan `set search_path` tetap, supaya tidak bisa "dibajak" lewat search_path.

-- 4a. Retrieval RAG: top-k chunk paling mirip, HANYA milik sesi pemanggil.
create or replace function public.match_chunks(
  query_embedding vector(1536),
  match_count int,
  p_session_id uuid
)
returns table (
  id uuid,
  document_id uuid,
  filename text,
  chunk_index int,
  content text,
  similarity float8
)
language sql
stable
strict -- argumen NULL → 0 baris (bukan hasil acak tanpa filter)
security invoker
set search_path = public, extensions
as $$
  select
    c.id,
    c.document_id,
    d.filename,
    c.chunk_index,
    c.content,
    -- `<=>` = cosine distance (0 = identik); similarity = 1 - distance.
    1 - (c.embedding <=> query_embedding) as similarity
  from public.chunks c
  join public.documents d on d.id = c.document_id
  -- WAJIB filter per sesi: tanpa ini user A bisa dapat jawaban dari dokumen
  -- user B. Dokumen yang masih 'processing' (chunk belum lengkap) atau
  -- 'failed' tidak ikut dicari.
  where d.session_id = p_session_id
    and d.status = 'ready'
  order by c.embedding <=> query_embedding
  -- Batas atas 50: retrieval tidak pernah butuh lebih, dan mencegah 1 panggilan
  -- menyedot seluruh isi dokumen sesi.
  limit least(greatest(match_count, 0), 50);
$$;

comment on function public.match_chunks(vector, int, uuid) is
  'Top-k chunk (cosine) milik 1 sesi, hanya dokumen berstatus ready.';

-- 4b. Insert dokumen + cek "maks N dokumen per sesi" secara ATOMIC.
-- Kenapa perlu lock: di isolation READ COMMITTED (default), 2 upload paralel
-- bisa sama-sama menghitung 4 dokumen, lalu sama-sama insert → 6 dokumen.
-- Advisory lock per sesi membuat count+insert untuk sesi yang sama antre satu
-- per satu; sesi lain tidak ikut menunggu.
-- Di bawah lock yang sama, nama file dibuat unik per sesi ("a.pdf" →
-- "a (2).pdf"): sitasi [nama_file, chunk #n] harus menunjuk tepat 1 dokumen.
-- Penomoran HANYA di sini — route mengirim nama apa adanya; kalau route ikut
-- menomori dari daftar yang dibacanya sendiri (tidak atomic), upload paralel
-- bernama sama dapat nomor dobel.
-- p_max_total_docs (opsional) = batas dokumen di SELURUH server: sesi baru
-- mudah dibuat, jadi batas per sesi saja tidak melindungi kuota database.
-- Versi lama fungsi ini (7 parameter) dibuang supaya tidak jadi overload ganda.
drop function if exists public.create_document(uuid, uuid, text, text, text, int, int);

create or replace function public.create_document(
  p_id uuid,
  p_session_id uuid,
  p_filename text,
  p_storage_path text,
  p_mime_type text,
  p_size_bytes int,
  p_max_docs int,
  p_max_total_docs int default null
)
returns public.documents
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_count int;
  v_doc public.documents;
  v_ext text;
  v_base text;
  v_filename text;
  v_suffix int := 2;
begin
  -- Tanpa guard ini, p_max_docs NULL membuat `v_count >= NULL` bernilai NULL
  -- (bukan true) → limit diam-diam tidak berlaku.
  if p_max_docs is null or p_max_docs < 1 then
    raise exception 'invalid_max_docs' using errcode = '22023';
  end if;
  if p_filename is null or btrim(p_filename) = '' then
    raise exception 'invalid_filename' using errcode = '22023';
  end if;

  -- Lock 2-kunci: kunci pertama = "namespace" fungsi ini, supaya tidak bentrok
  -- dengan pemakai advisory lock lain di database yang sama. Tabrakan hash
  -- antar sesi hanya membuat antre sedikit lebih lama, tidak salah hasil.
  -- Lock otomatis dilepas saat transaksi (= 1 panggilan RPC) selesai.
  perform pg_advisory_xact_lock(
    hashtext('public.create_document'),
    hashtext(p_session_id::text)
  );

  -- Batas global: count tanpa lock global (2 sesi paralel bisa melewatinya
  -- 1-2 dokumen) — cukup untuk melindungi kuota, tanpa membuat semua upload antre.
  if p_max_total_docs is not null then
    select count(*) into v_count from public.documents;
    if v_count >= p_max_total_docs then
      raise exception 'global_document_limit_reached'
        using errcode = 'P0001',
              detail = format('Server sudah menyimpan %s dokumen (maks %s).', v_count, p_max_total_docs);
    end if;
  end if;

  select count(*) into v_count
  from public.documents
  where session_id = p_session_id;

  if v_count >= p_max_docs then
    raise exception 'document_limit_reached'
      using errcode = 'P0001',
            detail = format('Sesi ini sudah punya %s dokumen (maks %s).', v_count, p_max_docs);
  end if;

  -- Ekstensi dipisah dengan aturan yang sama seperti sanitizeFilename() di
  -- lib/server/upload.ts: /\.[a-z0-9]{1,10}$/i. Nomor dicari sampai nama
  -- belum dipakai, jadi hasilnya selalu unik — termasuk kalau user sendiri
  -- mengupload "x (2).txt" (bentrok dengan nama itu → "x (2) (2).txt").
  v_ext := coalesce(substring(p_filename from '\.[A-Za-z0-9]{1,10}$'), '');
  v_base := left(p_filename, length(p_filename) - length(v_ext));
  v_filename := p_filename;
  while exists (
    select 1 from public.documents
    where session_id = p_session_id and lower(filename) = lower(v_filename)
  ) loop
    v_filename := format('%s (%s)%s', v_base, v_suffix, v_ext);
    v_suffix := v_suffix + 1;
  end loop;

  insert into public.documents (id, session_id, filename, storage_path, mime_type, size_bytes)
  values (p_id, p_session_id, v_filename, p_storage_path, p_mime_type, p_size_bytes)
  returning * into v_doc;

  return v_doc;
end;
$$;

-- 4c. Reservasi budget harian: SATU statement UPDATE bersyarat (atomic).
-- Jangan read-then-write di kode app: 2 request bersamaan bisa sama-sama lolos
-- cek sebelum salah satu sempat menulis → cap jebol saat traffic tinggi.
-- UPDATE mengunci baris hari ini; request berikutnya menunggu, lalu Postgres
-- MENGEVALUASI ULANG kondisi `where` terhadap nilai terbaru → total biaya
-- tidak pernah melewati budget, berapa pun request paralelnya.
-- Return: tanggal reservasi (dipakai lagi saat settle), atau NULL kalau
-- reservasi ini akan melewati budget (request harus ditolak).
create or replace function public.try_reserve_usage(p_cost numeric, p_budget numeric)
returns date
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_day date := public.usage_day();
  v_reserved date;
begin
  if p_cost is null or p_cost < 0 then
    raise exception 'invalid_cost' using errcode = '22023';
  end if;
  if p_budget is null or p_budget < 0 then
    raise exception 'invalid_budget' using errcode = '22023';
  end if;

  -- Pastikan baris hari ini ada (aman kalau 2 request membuat bersamaan).
  insert into public.usage_daily (day) values (v_day)
  on conflict (day) do nothing;

  update public.usage_daily
     set cost_usd = cost_usd + p_cost
   where day = v_day
     and cost_usd + p_cost <= p_budget
  returning day into v_reserved;

  return v_reserved; -- NULL = ditolak
end;
$$;

-- 4d. Catat pemakaian aktual: 1 upsert atomic.
-- p_cost boleh NEGATIF = mengembalikan sisa reservasi (biaya aktual biasanya
-- lebih kecil dari estimasi). p_day NULL = hari ini (dipakai untuk biaya
-- embedding yang tidak lewat reservasi). Untuk settle reservasi, kirim tanggal
-- reservasinya supaya refund masuk ke hari yang benar walau lewat tengah malam.
create or replace function public.record_usage(p_day date, p_tokens bigint, p_cost numeric)
returns void
language plpgsql
security invoker
set search_path = public, extensions
as $$
begin
  if p_tokens is null or p_tokens < 0 then
    raise exception 'invalid_tokens' using errcode = '22023';
  end if;
  if p_cost is null then
    raise exception 'invalid_cost' using errcode = '22023';
  end if;

  insert into public.usage_daily as u (day, tokens_used, cost_usd)
  values (coalesce(p_day, public.usage_day()), p_tokens, greatest(p_cost, 0))
  on conflict (day) do update
    set tokens_used = u.tokens_used + excluded.tokens_used,
        -- Pakai p_cost asli (bisa negatif), bukan excluded.cost_usd yang sudah
        -- di-clamp; greatest(..., 0) menjaga biaya tidak pernah minus.
        cost_usd = greatest(u.cost_usd + p_cost, 0);
end;
$$;

-- 4e. Pemakaian hari ini (selalu tepat 1 baris; 0 kalau belum ada pemakaian).
-- Dipakai untuk cek "budget habis?" & pesan error, dengan definisi "hari ini"
-- yang sama persis dengan fungsi-fungsi di atas.
create or replace function public.get_usage_today()
returns table (day date, tokens_used bigint, cost_usd numeric)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    t.day,
    coalesce(u.tokens_used, 0)::bigint,
    coalesce(u.cost_usd, 0)::numeric
  from (select public.usage_day() as day) t
  left join public.usage_daily u on u.day = t.day;
$$;

-- -----------------------------------------------------------------------------
-- 5. Hak akses (khusus Supabase; dilewati di Postgres biasa)
-- -----------------------------------------------------------------------------
-- Supabase memberi anon & authenticated hak ke tabel/fungsi baru di public
-- secara default. RLS tanpa policy sudah memblokir baris tabel, tapi kita
-- cabut juga haknya (defense in depth + tidak muncul di API publik), lalu
-- beri hak eksplisit hanya ke service_role (dipakai server Next.js).
do $$
declare
  fn regprocedure;
  r name;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'usage_day', 'match_chunks', 'create_document',
        'try_reserve_usage', 'record_usage', 'get_usage_today'
      )
  loop
    -- PUBLIC = semua role; default Postgres memberi EXECUTE ke PUBLIC.
    execute format('revoke all on function %s from public', fn);
    for r in
      select rolname from pg_roles where rolname in ('anon', 'authenticated')
    loop
      execute format('revoke all on function %s from %I', fn, r);
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;

  for r in
    select rolname from pg_roles where rolname in ('anon', 'authenticated')
  loop
    execute format(
      'revoke all on table public.documents, public.chunks, public.usage_daily from %I', r
    );
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete
      on table public.documents, public.chunks, public.usage_daily
      to service_role;
  else
    raise notice 'Role Supabase tidak ditemukan (Postgres biasa?) — langkah grant/revoke role dilewati.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Storage bucket (khusus Supabase; dilewati di Postgres biasa)
-- -----------------------------------------------------------------------------
-- Bucket PRIVATE: file hanya bisa diakses lewat service role di server.
-- storage.objects di Supabase sudah ber-RLS; tanpa policy, anon tidak bisa
-- list/download. Batas ukuran & MIME di level Storage = lapisan pertahanan
-- kedua kalau validasi di API route sampai kebobolan. Nilainya harus sinkron
-- dengan MAX_FILE_BYTES & AllowedMimeType di lib/config.ts.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'documents', 'documents', false, 5242880,
      array['application/pdf', 'text/markdown', 'text/plain']
    )
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  else
    raise notice 'Schema storage tidak ditemukan (Postgres biasa?) — pembuatan bucket dilewati.';
  end if;
end
$$;

commit;
