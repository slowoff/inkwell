-- Inkwell 1.72: db_size() runs with the caller's own rights (security invoker). Signed-in accounts can read the
-- database size themselves (CONNECT is enough for pg_database_size), so the function needs no extra rights and the
-- security advisor no longer flags it. Anonymous visitors still cannot call it.
alter function public.db_size() security invoker;
revoke execute on function public.db_size() from public, anon;
grant execute on function public.db_size() to authenticated;
