alter table public.multiplayer_presence
  add column if not exists last_location jsonb,
  add column if not exists last_location_recorded_at timestamptz;

alter table public.multiplayer_presence
  drop constraint if exists multiplayer_presence_starting_location_source_chk;

alter table public.multiplayer_presence
  add constraint multiplayer_presence_starting_location_source_chk
  check (
    starting_location_source is null
    or starting_location_source in ('default', 'random', 'user_preference', 'last_location')
  );

comment on column public.multiplayer_presence.starting_location is
  'Optional structured player starting location. Null falls back to the current default starting location: Grid 1 top level, IP 247.0.0.0. Expected JSON includes gridSystemMode, ipAddress, and source; Grid 1 records may include zoomLevel and currentPosition, and Grid 2 records may include grid2Position and cell coordinates. Source may be default, random, user_preference, or last_location.';

comment on column public.multiplayer_presence.starting_location_source is
  'Optional source for starting_location: default, random, user_preference, or last_location. Null means use the fallback default: Grid 1 top level, IP 247.0.0.0.';

comment on column public.multiplayer_presence.last_location is
  'Optional structured most recent player location for future last-location starts. Null means no last location has been recorded and fallback remains Grid 1 top level, IP 247.0.0.0.';

comment on column public.multiplayer_presence.last_location_recorded_at is
  'Time when last_location was recorded.';
