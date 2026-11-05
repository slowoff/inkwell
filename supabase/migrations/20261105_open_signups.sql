-- Inkwell 1.88: safe for open sign-ups. Nothing is deleted.
-- docs_guard added up all of an account's notes for every row that grows, so a big upload from an account with a limit got slower
-- with each row (it can run into the 8 s statement limit). The sum is now made once per upload and kept up to date.
-- Accounts with a limit also stop growing when the whole database passes 450 MB (the free plan has 500 MB), so new sign-ups cannot
-- fill it up for everyone. Accounts without a limit (limits.notes_mb null) are not affected. Edits that do not grow always work.
create or replace function public.docs_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare lim integer; used bigint; old_size bigint; new_size bigint; cached text; db bigint;
begin
  new_size := coalesce(pg_column_size(new.data), 0);
  if new_size > 8000000 then raise exception 'doc_too_big'; end if;
  select notes_mb into lim from public.limits where user_id = new.user_id;
  if not found then lim := 50; end if;
  if lim is null then return new; end if;
  select pg_column_size(d.data) into old_size from public.docs d where d.user_id = new.user_id and d.id = new.id;
  if new_size <= coalesce(old_size, 0) then return new; end if;
  cached := current_setting('inkwell.used', true);
  if cached is null or cached = '' or current_setting('inkwell.used_for', true) is distinct from new.user_id::text then
    select coalesce(sum(pg_column_size(data)), 0) into used from public.docs where user_id = new.user_id;
    db := pg_database_size(current_database());
    perform set_config('inkwell.used_for', new.user_id::text, true);
    perform set_config('inkwell.db', db::text, true);
  else
    used := cached::bigint;
    db := current_setting('inkwell.db')::bigint;
  end if;
  if used > lim::bigint * 1048576 or db > 450 * 1048576::bigint then raise exception 'notes_full'; end if;
  perform set_config('inkwell.used', (used + new_size - coalesce(old_size, 0))::text, true);
  return new;
end $$;
revoke execute on function public.docs_guard() from public, anon, authenticated;
