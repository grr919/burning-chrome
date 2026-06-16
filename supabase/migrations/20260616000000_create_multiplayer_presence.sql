create table if not exists public.multiplayer_presence (
  presence_id text primary key,
  session_id text not null,
  user_id text not null,
  display_name text not null,
  color text not null,
  avatar_url text,
  avatar_type text not null default 'default',
  location_key text not null,
  grid_system_mode text not null,
  view_mode text not null default 'grid',
  zoom_level integer not null,
  current_position jsonb not null,
  grid2_position jsonb not null,
  player_location jsonb,
  pointer_target jsonb,
  hovered_cell jsonb,
  selected_ip text,
  chat_location_key text,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.multiplayer_presence is
  'Authoritative active multiplayer session presence for Burning Chrome.';

create index if not exists multiplayer_presence_location_key_idx
  on public.multiplayer_presence (location_key);

create index if not exists multiplayer_presence_last_seen_idx
  on public.multiplayer_presence (last_seen);

drop trigger if exists set_multiplayer_presence_updated_at on public.multiplayer_presence;
create trigger set_multiplayer_presence_updated_at
before update on public.multiplayer_presence
for each row execute function public.set_updated_at();

alter table public.multiplayer_presence enable row level security;

drop policy if exists "multiplayer presence is readable" on public.multiplayer_presence;
create policy "multiplayer presence is readable"
on public.multiplayer_presence
for select
to anon, authenticated
using (true);

drop policy if exists "multiplayer presence can be inserted" on public.multiplayer_presence;
create policy "multiplayer presence can be inserted"
on public.multiplayer_presence
for insert
to anon, authenticated
with check (true);

drop policy if exists "multiplayer presence can be updated" on public.multiplayer_presence;
create policy "multiplayer presence can be updated"
on public.multiplayer_presence
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists "multiplayer presence can be deleted" on public.multiplayer_presence;
create policy "multiplayer presence can be deleted"
on public.multiplayer_presence
for delete
to anon, authenticated
using (true);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'multiplayer_presence'
  ) then
    alter publication supabase_realtime add table public.multiplayer_presence;
  end if;
end;
$$;
