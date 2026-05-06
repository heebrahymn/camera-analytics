-- =========================
-- Extensions
-- =========================
create extension if not exists pgcrypto with schema extensions;

-- =========================
-- Profiles + auto-create trigger
-- =========================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Generic updated_at trigger fn
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

-- =========================
-- Stores
-- =========================
create table public.stores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  address text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stores_owner_idx on public.stores(owner_id);
alter table public.stores enable row level security;

create policy "stores_owner_all" on public.stores
  for all to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create trigger stores_updated before update on public.stores
  for each row execute function public.set_updated_at();

-- =========================
-- Cameras
-- =========================
create type public.camera_status as enum ('online','offline','error','pending');

create table public.cameras (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  rtsp_url text not null,
  rtsp_username text,
  rtsp_password text,
  location_label text,
  status public.camera_status not null default 'pending',
  last_seen_at timestamptz,
  -- counting line: two points in normalized [0,1] image coords
  line_config jsonb not null default '{"x1":0.0,"y1":0.5,"x2":1.0,"y2":0.5}'::jsonb,
  -- ingest_key is opaque token used by the worker; hashed equivalent stored separately would be ideal,
  -- here we store directly with strict RLS so only the owner can read it.
  ingest_key text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cameras_owner_idx on public.cameras(owner_id);
create index cameras_store_idx on public.cameras(store_id);
create unique index cameras_ingest_key_idx on public.cameras(ingest_key);

alter table public.cameras enable row level security;

create policy "cameras_owner_all" on public.cameras
  for all to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create trigger cameras_updated before update on public.cameras
  for each row execute function public.set_updated_at();

-- =========================
-- Vehicle events
-- =========================
create type public.vehicle_direction as enum ('entry','exit');

create table public.vehicle_events (
  id bigserial primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  camera_id uuid not null references public.cameras(id) on delete cascade,
  direction public.vehicle_direction not null,
  track_id text,
  occurred_at timestamptz not null default now(),
  confidence real,
  created_at timestamptz not null default now()
);
create index vehicle_events_owner_time_idx on public.vehicle_events(owner_id, occurred_at desc);
create index vehicle_events_camera_time_idx on public.vehicle_events(camera_id, occurred_at desc);
create index vehicle_events_store_time_idx on public.vehicle_events(store_id, occurred_at desc);

alter table public.vehicle_events enable row level security;

-- Owner can read their events. Inserts come from the edge function with service role (bypasses RLS).
create policy "vehicle_events_owner_select" on public.vehicle_events
  for select to authenticated using (auth.uid() = owner_id);

-- =========================
-- Hourly aggregates
-- =========================
create table public.count_aggregates_hourly (
  id bigserial primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  camera_id uuid not null references public.cameras(id) on delete cascade,
  bucket_start timestamptz not null, -- truncated to hour UTC
  entries integer not null default 0,
  exits integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (camera_id, bucket_start)
);
create index agg_owner_bucket_idx on public.count_aggregates_hourly(owner_id, bucket_start desc);
create index agg_store_bucket_idx on public.count_aggregates_hourly(store_id, bucket_start desc);

alter table public.count_aggregates_hourly enable row level security;

create policy "agg_owner_select" on public.count_aggregates_hourly
  for select to authenticated using (auth.uid() = owner_id);

-- Trigger: when a vehicle_event is inserted, upsert into the hourly aggregate
create or replace function public.apply_vehicle_event_to_aggregate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bucket timestamptz := date_trunc('hour', new.occurred_at);
begin
  insert into public.count_aggregates_hourly
    (owner_id, store_id, camera_id, bucket_start, entries, exits)
  values
    (new.owner_id, new.store_id, new.camera_id, bucket,
      case when new.direction = 'entry' then 1 else 0 end,
      case when new.direction = 'exit'  then 1 else 0 end)
  on conflict (camera_id, bucket_start) do update
    set entries = public.count_aggregates_hourly.entries
                  + case when new.direction = 'entry' then 1 else 0 end,
        exits   = public.count_aggregates_hourly.exits
                  + case when new.direction = 'exit'  then 1 else 0 end,
        updated_at = now();
  return new;
end;
$$;

create trigger vehicle_events_aggregate
after insert on public.vehicle_events
for each row execute function public.apply_vehicle_event_to_aggregate();

-- =========================
-- Realtime
-- =========================
alter publication supabase_realtime add table public.vehicle_events;
alter publication supabase_realtime add table public.count_aggregates_hourly;
alter publication supabase_realtime add table public.cameras;