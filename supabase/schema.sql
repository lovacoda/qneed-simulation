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
