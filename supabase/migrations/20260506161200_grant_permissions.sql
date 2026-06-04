-- Grant table permissions to authenticated and service_role (anon is excluded for security)
grant select, insert, update, delete on table public.profiles to authenticated, service_role;
grant select, insert, update, delete on table public.stores to authenticated, service_role;
grant select, insert, update, delete on table public.cameras to authenticated, service_role;
grant select, insert, update, delete on table public.vehicle_events to authenticated, service_role;
grant select, insert, update, delete on table public.count_aggregates_hourly to authenticated, service_role;

-- Grant sequence usage permissions
grant usage, select on all sequences in schema public to authenticated, service_role;

