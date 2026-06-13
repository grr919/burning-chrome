-- Stage 1 foundation for future cached/enriched IP metadata.
-- These tables are not wired into frontend rendering yet; current live lookups remain authoritative.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.ip_metadata (
  ip_address inet primary key,
  asn text,
  asn_name text,
  asn_country text,
  rdap_org text,
  rdap_network_name text,
  rdap_country text,
  reverse_dns text[],
  open_ports integer[],
  services text[],
  hostnames text[],
  flag_country_code text,
  flag_url text,
  source_status text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ip_metadata is
  'Future exact-IP metadata cache for Burning Chrome. Not yet wired into frontend rendering.';
comment on column public.ip_metadata.flag_country_code is
  'Future flag resolution source; frontend flag rendering is not wired to this cache in Stage 1.';
comment on column public.ip_metadata.flag_url is
  'Future cached flag image URL; frontend flag rendering is not wired to this cache in Stage 1.';

create table if not exists public.ip_prefixes (
  prefix cidr primary key,
  asn text,
  asn_name text,
  country text,
  rdap_org text,
  rdap_network_name text,
  registry text,
  source_status text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ip_prefixes is
  'Future prefix/range metadata cache for applying shared metadata to many IPs.';

create table if not exists public.asn_metadata (
  asn text primary key,
  asn_name text,
  country text,
  registry text,
  route text,
  source_status text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.asn_metadata is
  'Future ASN-level metadata cache for Burning Chrome. Not yet wired into frontend rendering.';

create table if not exists public.reverse_dns_cache (
  ip_address inet primary key,
  hostnames text[],
  ptr_hostnames text[],
  fallback_hostnames text[],
  source_status text,
  error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.reverse_dns_cache is
  'Future reverse-DNS metadata cache. Current live reverse-DNS lookup behavior is unchanged.';

create table if not exists public.exposure_cache (
  ip_address inet primary key,
  source_provider text,
  service_count integer,
  open_port_count integer,
  top_ports text[],
  open_ports integer[],
  service_names text[],
  labels text[],
  hostnames text[],
  warning text,
  error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.exposure_cache is
  'Future public exposure/service metadata cache. Current live exposure lookup behavior is unchanged.';

create index if not exists ip_metadata_last_checked_at_idx on public.ip_metadata (last_checked_at);
create index if not exists ip_prefixes_prefix_gist_idx on public.ip_prefixes using gist (prefix inet_ops);
create index if not exists ip_prefixes_last_checked_at_idx on public.ip_prefixes (last_checked_at);
create index if not exists asn_metadata_last_checked_at_idx on public.asn_metadata (last_checked_at);
create index if not exists reverse_dns_cache_last_checked_at_idx on public.reverse_dns_cache (last_checked_at);
create index if not exists exposure_cache_last_checked_at_idx on public.exposure_cache (last_checked_at);

drop trigger if exists set_ip_metadata_updated_at on public.ip_metadata;
create trigger set_ip_metadata_updated_at
before update on public.ip_metadata
for each row execute function public.set_updated_at();

drop trigger if exists set_ip_prefixes_updated_at on public.ip_prefixes;
create trigger set_ip_prefixes_updated_at
before update on public.ip_prefixes
for each row execute function public.set_updated_at();

drop trigger if exists set_asn_metadata_updated_at on public.asn_metadata;
create trigger set_asn_metadata_updated_at
before update on public.asn_metadata
for each row execute function public.set_updated_at();

drop trigger if exists set_reverse_dns_cache_updated_at on public.reverse_dns_cache;
create trigger set_reverse_dns_cache_updated_at
before update on public.reverse_dns_cache
for each row execute function public.set_updated_at();

drop trigger if exists set_exposure_cache_updated_at on public.exposure_cache;
create trigger set_exposure_cache_updated_at
before update on public.exposure_cache
for each row execute function public.set_updated_at();

alter table public.ip_metadata enable row level security;
alter table public.ip_prefixes enable row level security;
alter table public.asn_metadata enable row level security;
alter table public.reverse_dns_cache enable row level security;
alter table public.exposure_cache enable row level security;

-- No public policies are added in Stage 1. Future cache reads/writes should add
-- narrowly scoped policies or use trusted server-side routes/service roles.
