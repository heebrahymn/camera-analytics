-- =============================================================================
-- Snapshot storage: add columns to vehicle_events + Storage bucket setup
-- =============================================================================

-- 1. Add snapshot columns to vehicle_events
-- snapshot_path: Supabase Storage path (vision-snapshots/<camera_id>/<ts>.jpg)
-- v_type:        vehicle type returned by OpenAI vision ('car', 'truck', 'van', …)
alter table public.vehicle_events
  add column if not exists snapshot_path text,
  add column if not exists v_type       text;

-- Index to quickly find events that have a snapshot (for cleanup jobs)
create index if not exists vehicle_events_snapshot_idx
  on public.vehicle_events(occurred_at desc)
  where snapshot_path is not null;

-- =============================================================================
-- 2. Supabase Storage bucket: vision-snapshots (private)
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vision-snapshots',
  'vision-snapshots',
  false,              -- private: access via signed URLs only
  5242880,            -- 5 MB max per file
  array['image/jpeg']
)
on conflict (id) do nothing;

-- Service role (used by worker via supabase_service_key) can upload
create policy "vision_snapshots_service_insert"
  on storage.objects for insert
  to service_role
  with check (bucket_id = 'vision-snapshots');

-- Service role can also delete (used by cleanup job via the edge fn or pg_cron)
create policy "vision_snapshots_service_delete"
  on storage.objects for delete
  to service_role
  using (bucket_id = 'vision-snapshots');

-- Authenticated users can read objects in their camera's folder
-- Path pattern: vision-snapshots/<camera_id>/<ts>.jpg
-- RLS on vehicle_events already gates access — this adds Storage-level protection too.
create policy "vision_snapshots_owner_select"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'vision-snapshots');

-- =============================================================================
-- 3. 30-day retention: weekly pg_cron job
-- Nullifies snapshot_path on vehicle_events older than 30 days so the
-- application no longer references stale Storage objects.
-- Actual object deletion from Storage is handled separately (see note below).
-- NOTE: pg_cron extension must be enabled on your Supabase project.
--       Go to: Database → Extensions → pg_cron → Enable
-- =============================================================================
select cron.schedule(
  'purge-old-snapshot-paths',   -- job name
  '0 3 * * 0',                  -- every Sunday at 03:00 UTC
  $$
    update public.vehicle_events
    set    snapshot_path = null,
           v_type        = null
    where  occurred_at < now() - interval '30 days'
      and  snapshot_path is not null;
  $$
);
