-- Grant table permissions to anon, authenticated, and service_role
grant select, insert, update, delete on table public.profiles to anon, authenticated, service_role;
grant select, insert, update, delete on table public.stores to anon, authenticated, service_role;
grant select, insert, update, delete on table public.cameras to anon, authenticated, service_role;
grant select, insert, update, delete on table public.vehicle_events to anon, authenticated, service_role;
grant select, insert, update, delete on table public.count_aggregates_hourly to anon, authenticated, service_role;

-- Grant sequence usage permissions
grant usage, select on all sequences in schema public to anon, authenticated, service_role;
