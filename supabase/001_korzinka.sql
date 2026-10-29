-- Корзинка: таблицы в том же проекте Supabase, что и «Задачи».
-- Вставить целиком в Supabase → SQL Editor → Run. Можно запускать повторно.

-- Группы (категории) товаров.
create table if not exists k_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  emoji text not null default '',
  ord int not null default 0,
  created_at timestamptz not null default now()
);

-- Магазины: сайт и ссылка поиска ({q} — название товара).
create table if not exists k_stores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  emoji text not null default '',
  url text not null default '',
  search_url text not null default '',
  ord int not null default 0,
  created_at timestamptz not null default now()
);

-- Товары.
create table if not exists k_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  note text not null default '',
  group_id uuid references k_groups on delete set null,
  store_id uuid references k_stores on delete set null,
  emoji text not null default '',
  image text not null default '',            -- маленькое фото (data:image/jpeg;base64,…)
  price numeric not null default 0,          -- примерная цена, ₴
  need boolean not null default false,       -- закончилось, надо купить
  in_cart boolean not null default false,    -- в магазине отмечено «купила»
  one_off boolean not null default false,    -- разовая покупка
  history jsonb not null default '[]',       -- когда покупали (мс)
  norm int not null default 0,               -- заначка: сколько должно быть (0 — не следим)
  check_every int not null default 14,       -- заначка: напоминать пересчитать раз в N дней
  stock int,                                 -- заначка: сколько было при последнем пересчёте
  checked_at timestamptz,                    -- заначка: когда пересчитывали
  created_at timestamptz not null default now()
);

alter table k_groups enable row level security;
alter table k_stores enable row level security;
alter table k_items enable row level security;
drop policy if exists own on k_groups;
drop policy if exists own on k_stores;
drop policy if exists own on k_items;
create policy own on k_groups for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on k_stores for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on k_items for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on k_groups, k_stores, k_items to authenticated;

-- Живая синхронизация: изменения на телефоне сразу видны на компьютере и наоборот.
do $$ begin
  begin alter publication supabase_realtime add table k_groups; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table k_stores; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table k_items; exception when duplicate_object then null; end;
end $$;

-- Уведомления: подписка помнит, из какого приложения она (у старых — «Задачи»),
-- и раз в день Корзинка напоминает пересчитать заначку.
alter table push_subs add column if not exists app text not null default 'tasks';
alter table prefs add column if not exists korz_time time not null default '10:00';
alter table prefs add column if not exists korz_last date;
