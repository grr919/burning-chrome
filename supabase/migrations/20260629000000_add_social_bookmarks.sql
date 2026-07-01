create table if not exists public.user_follows (
  follower_user_id text not null,
  followed_user_id text not null,
  created_at timestamptz not null default now(),
  constraint user_follows_pkey primary key (follower_user_id, followed_user_id),
  constraint user_follows_no_self check (follower_user_id <> followed_user_id)
);

create table if not exists public.user_bookmarks (
  user_id text not null,
  ip_address text not null,
  organization_name text,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_bookmarks_pkey primary key (user_id, ip_address)
);

create or replace function public.set_user_bookmarks_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_bookmarks_updated_at on public.user_bookmarks;
create trigger set_user_bookmarks_updated_at
before update on public.user_bookmarks
for each row
execute function public.set_user_bookmarks_updated_at();
