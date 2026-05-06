-- Set search_path on set_updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin new.updated_at = now(); return new; end;
$$;

-- Revoke public/anon/authenticated execute on internal definer functions
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.apply_vehicle_event_to_aggregate() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;