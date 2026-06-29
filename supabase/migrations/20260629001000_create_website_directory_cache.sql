create table if not exists public.website_directory_cache (
  id uuid primary key default gen_random_uuid(),
  ip_address inet not null,
  hostname text not null,
  url text,
  source text not null,
  source_detail text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  currently_resolves_to_ip boolean not null default false,
  http_status integer,
  redirect_url text,
  title text,
  server_header text,
  confidence integer not null default 0,
  rank_category text not null,
  last_checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint website_directory_cache_ip_hostname_key unique (ip_address, hostname),
  constraint website_directory_cache_rank_category_check check (
    rank_category in ('currently_verified', 'currently_resolves', 'cached_or_observed', 'unverified')
  )
);

comment on table public.website_directory_cache is
  'Backend-maintained no-paid website directory cache for likely websites associated with exact IP addresses.';

create index if not exists website_directory_cache_ip_address_idx on public.website_directory_cache (ip_address);
create index if not exists website_directory_cache_hostname_idx on public.website_directory_cache (hostname);
create index if not exists website_directory_cache_last_checked_at_idx on public.website_directory_cache (last_checked_at);
create index if not exists website_directory_cache_rank_category_idx on public.website_directory_cache (rank_category);

drop trigger if exists set_website_directory_cache_updated_at on public.website_directory_cache;
create trigger set_website_directory_cache_updated_at
before update on public.website_directory_cache
for each row execute function public.set_updated_at();

alter table public.website_directory_cache enable row level security;

-- No public policy is added. The website-directory API route reads and writes
-- through backend-only Supabase service credentials and returns safe JSON.
