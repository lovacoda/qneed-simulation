-- qneed AI İkiz — Supabase şeması
-- Supabase panelinde: SQL Editor > New query > bu dosyayı yapıştır > Run

-- Geçmiş satış konuşmaların (ikizi "sen" gibi konuşturan eğitim verisi)
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,               -- dosya adından; tekrar yüklemede günceller
  title text,
  channel text default 'whatsapp',
  outcome text default 'unknown',          -- sold | lost | open | unknown
  is_exemplar boolean default false,       -- ikiz bu konuşmanın tarzını taklit etsin mi
  quality int default 3,                   -- 1-5, ne kadar iyi bir örnek
  tags text[] default '{}',
  notes text,
  happened_at date,
  created_at timestamptz default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  position int not null,
  speaker text not null,                   -- customer | me
  text text not null,
  created_at timestamptz default now()
);
create index if not exists messages_conversation_idx on messages(conversation_id, position);

-- Ürün kataloğu
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  price numeric,
  currency text default 'TRY',
  category text,
  good_for text,                           -- kime/hangi cilde uygun
  description text,
  created_at timestamptz default now()
);

-- İkizin kendi görüşme kayıtları (öğrenme döngüsü için)
create table if not exists chat_logs (
  id uuid primary key default gen_random_uuid(),
  transcript jsonb not null,
  created_at timestamptz default now()
);

-- ============================================================================
-- RAG: anlam parmak izi (embedding) ile "duruma uygun" konuşma araması
-- Gelen müşteri mesajına en yakın konuşmaları bulup sistem promptuna koyarız.
-- Bu bloğu var olan bir veritabanında yeniden çalıştırmak güvenlidir (idempotent).
-- NOT: EMBED_DIM ile buradaki vector(1024) aynı olmalı. Voyage voyage-3.5 = 1024.
-- ============================================================================
create extension if not exists vector;

alter table conversations add column if not exists embedding vector(1024);

-- Yaklaşık en-yakın-komşu araması için index (kosinüs mesafesi).
create index if not exists conversations_embedding_idx
  on conversations using hnsw (embedding vector_cosine_ops);

-- Sorgu vektörüne en yakın konuşmaları benzerlik puanıyla döndürür.
-- similarity = 1 - kosinüs mesafesi (1'e yakın = çok benzer).
create or replace function match_conversations(
  query_embedding vector(1024),
  match_count int
)
returns table (
  id uuid,
  title text,
  outcome text,
  similarity float
)
language sql stable
as $$
  select
    c.id,
    c.title,
    c.outcome,
    1 - (c.embedding <=> query_embedding) as similarity
  from conversations c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================================
-- Ürün görselleri: Storage kovası + products.image_url
-- Görseli veritabanına dosya olarak koymuyoruz; Storage'a koyup public URL'i
-- saklıyoruz. Instagram/WhatsApp DM API'leri zaten public bir HTTPS linki
-- istiyor — böylece kayıtlı URL doğrudan gönderime gidebiliyor.
-- Bu blok idempotent: var olan bir veritabanında tekrar çalıştırılabilir.
-- ============================================================================
alter table products add column if not exists image_url text;
-- Birden fazla ürün görseli. image_url ilk/ana görsel olarak kalır (katalog
-- küçük resmi); image_urls tamamını tutar ve DM'de sırayla gönderilir.
alter table products add column if not exists image_urls text[] default '{}';

-- 'product-images' adlı public kovayı uygulama ilk yüklemede kendisi oluşturur
-- (src/storage.ts). Burada elle bir şey yapman gerekmiyor.

-- ============================================================================
-- Instagram DM kanalı (Faz 2)
-- CANLI sohbet burada durur; yukarıdaki conversations/messages ise EĞİTİM
-- verisi (ikizin tarzını öğrendiği geçmiş yazışmalar). Karıştırma.
-- Bu blok idempotent: var olan bir veritabanında tekrar çalıştırılabilir.
-- ============================================================================
create table if not exists ig_threads (
  id uuid primary key default gen_random_uuid(),
  ig_user_id text unique not null,          -- müşterinin Instagram-scoped ID'si
  username text,
  auto_reply boolean default true,          -- bu sohbette ikiz cevaplasın mı
  paused_until timestamptz,                 -- sen telefondan yazınca dolar
  last_message_at timestamptz,
  created_at timestamptz default now()
);

-- DM'de ikiz, sohbete tetikleyici kelime gelene kadar YAZMAZ. Kelime gelince
-- o sohbet açılır (unlocked) ve normal konuşmaya devam eder. Yorumdan başlayan
-- sohbetler baştan açıktır (DM'i zaten biz başlatmışız).
alter table ig_threads add column if not exists unlocked boolean default false;

create table if not exists ig_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references ig_threads(id) on delete cascade,
  mid text unique,                          -- Meta mesaj ID'si; tekrar gelen webhook'u eler
  role text not null,                       -- customer | assistant | human
  text text not null,
  image_url text,                           -- Meta CDN linki (24 saat sonra ölür)
  created_at timestamptz default now()
);
create index if not exists ig_messages_thread_idx on ig_messages(thread_id, created_at);

-- Yorum tetikleyicileri: "gönderiye şu kelimeyi yazana DM at" kuralları.
-- Kontrol panelinden (http://localhost:3940/durum) yönetilir.
create table if not exists ig_triggers (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,                    -- normalize saklanır; '*' = her mesaj/yorum
  media_id text,                            -- null = bütün gönderiler (sadece yorum için)
  dm_text text,                             -- null = mesajı ikiz kendi yazsın
  public_reply text,                        -- null = yorumun altına cevap yazma
  active boolean default true,
  created_at timestamptz default now()
);
-- Nerede tetiklensin: comment | dm | both. Ne yapsın: ai | reply | product | handover.
alter table ig_triggers add column if not exists source text default 'comment';
alter table ig_triggers add column if not exists action text default 'ai';
alter table ig_triggers add column if not exists product_slug text;

-- Ayarlar: sistem promptu ve işletme notu. Eskiden data/prompt.md dosyasındaydı;
-- sunucu buluta taşınınca yerel dosyayı göremediği için veritabanına alındı.
-- Böylece laboratuvar (yerel) düzenler, buluttaki sunucu anında kullanır.
create table if not exists settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

-- Telegram bildirimi <-> sohbet eşlemesi. Telegram'da bir bildirime
-- "kaydırıp yanıtla" ile /pause yazdığında hangi müşteriden bahsettiğini
-- buradan buluyoruz.
create table if not exists tg_links (
  tg_message_id bigint primary key,
  thread_id uuid not null references ig_threads(id) on delete cascade,
  created_at timestamptz default now()
);

-- Gelen yorumlar + ne yapıldığı. comment_id benzersiz: Meta yorum başına
-- ÖMÜR BOYU tek "private reply" hakkı veriyor, tekrar gelen webhook'ta
-- ikinci kez denemeyelim.
create table if not exists ig_comments (
  id uuid primary key default gen_random_uuid(),
  comment_id text unique not null,
  ig_user_id text,
  username text,
  media_id text,
  text text,
  matched_keyword text,
  dm_sent boolean default false,
  skipped_reason text,
  created_at timestamptz default now()
);
