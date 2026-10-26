-- Inkwell 1.64: how big the database is, for the storage line in Settings (free plan: 500 MB).
-- Only the total size (no data). Signed-in accounts may ask; anonymous visitors may not.
create or replace function public.db_size()
returns bigint
language sql
security definer
set search_path = public
as $$ select pg_database_size(current_database()) $$;

revoke execute on function public.db_size() from public, anon;
grant execute on function public.db_size() to authenticated;
