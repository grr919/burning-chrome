alter table public.multiplayer_presence
  add column if not exists starting_location jsonb,
  add column if not exists starting_location_source text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'multiplayer_presence_starting_location_source_chk'
      and conrelid = 'public.multiplayer_presence'::regclass
  ) then
    alter table public.multiplayer_presence
      add constraint multiplayer_presence_starting_location_source_chk
      check (
        starting_location_source is null
        or starting_location_source in ('default', 'random', 'user_preference')
      );
  end if;
end;
$$;

comment on column public.multiplayer_presence.starting_location is
  'Optional structured player starting location. Null falls back to the current default starting location: Grid 1 top level, IP 247.0.0.0. Expected JSON includes gridSystemMode, ipAddress, and source; Grid 1 records may include zoomLevel and currentPosition, and Grid 2 records may include grid2Position and cell coordinates.';

comment on column public.multiplayer_presence.starting_location_source is
  'Optional source for starting_location: default, random, or user_preference. Null means use the fallback default: Grid 1 top level, IP 247.0.0.0.';
