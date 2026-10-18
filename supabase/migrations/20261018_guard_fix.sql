-- Inkwell 1.36: notes limit fix and small security/performance fixes (found in the 2026-10-18 check).
-- Applied to project "inkwell" (pubaedzrgrkjifmiqiew) as migration inkwell_guard_fix.

-- 1. docs_guard: the app saves with upsert, which always arrives as INSERT first. The old check therefore treated every
--    edit as a new doc: an account over its notes limit could not even edit, shrink or delete anything.
--    Now only growth is refused when the account is over its limit; edits that keep or reduce the size, and deletes, always work.
create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare lim integer; used bigint; old_size bigint;
begin
  if pg_column_size(new.data) > 8000000 then raise exception 'doc_too_big'; end if;
  select notes_mb into lim from public.limits where user_id = new.user_id;
  if not found then lim := 50; end if;
  if lim is null then return new; end if;
  select pg_column_size(d.data) into old_size from public.docs d where d.user_id = new.user_id and d.id = new.id;
  if coalesce(pg_column_size(new.data), 0) <= coalesce(old_size, 0) then return new; end if;
  select coalesce(sum(pg_column_size(data)), 0) into used from public.docs where user_id = new.user_id;
  if used > lim::bigint * 1048576 then raise exception 'notes_full'; end if;
  return new;
end $$;
-- it is only a trigger: nobody should call it through the API
revoke execute on function public.docs_guard() from public, anon, authenticated;

-- 2. row-level security: evaluate auth.uid() once per query instead of once per row (Supabase performance advisor)
drop policy if exists "read own limits" on public.limits;
create policy "read own limits" on public.limits for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "read own usage" on public.usage_month;
create policy "read own usage" on public.usage_month for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "read own files" on public.files;
create policy "read own files" on public.files for select to authenticated using (user_id = (select auth.uid()));
