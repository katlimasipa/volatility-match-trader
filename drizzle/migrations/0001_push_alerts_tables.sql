create table if not exists public.bot_alerts (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  device_id text not null default '',
  kind text not null default 'info',
  title text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists bot_alerts_room_created_idx
  on public.bot_alerts (room_id, created_at desc);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  device_id text not null default '',
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_room_idx
  on public.push_subscriptions (room_id);

alter table public.bot_alerts enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists bot_alerts_select on public.bot_alerts;
create policy bot_alerts_select on public.bot_alerts
  for select using (true);

drop policy if exists bot_alerts_insert on public.bot_alerts;
create policy bot_alerts_insert on public.bot_alerts
  for insert with check (true);

drop policy if exists push_subs_select on public.push_subscriptions;
create policy push_subs_select on public.push_subscriptions
  for select using (true);

drop policy if exists push_subs_insert on public.push_subscriptions;
create policy push_subs_insert on public.push_subscriptions
  for insert with check (true);

drop policy if exists push_subs_update on public.push_subscriptions;
create policy push_subs_update on public.push_subscriptions
  for update using (true);

drop policy if exists push_subs_delete on public.push_subscriptions;
create policy push_subs_delete on public.push_subscriptions
  for delete using (true);

grant select, insert, update, delete on public.bot_alerts to anon, authenticated;
grant all on public.bot_alerts to service_role;
grant select, insert, update, delete on public.push_subscriptions to anon, authenticated;
grant all on public.push_subscriptions to service_role;