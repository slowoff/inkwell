-- Inkwell 1.27: per-account limits, Claude spending log, picture list for Cloudflare R2.
-- Applied to project "inkwell" (pubaedzrgrkjifmiqiew) as migration inkwell_limits_and_files.

-- Limits per account. A missing row means the defaults for new accounts:
-- 1000 MB of pictures, 50 MB of notes, USD 2 of Claude per month (Claude also needs the email on ASK_ALLOWED_EMAILS).
-- null in a column = unlimited.
create table if not exists public.limits (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  storage_mb       integer,
  notes_mb         integer,
  claude_usd_month numeric
);

-- Claude spending per account and month (written by the ask function only)
create table if not exists public.usage_month (
  user_id    uuid not null references auth.users(id) on delete cascade,
  month      text not null,
  claude_usd numeric not null default 0,
  primary key (user_id, month)
);

-- Pictures stored in Cloudflare R2 (written by the files function only)
create table if not exists public.files (
  user_id    uuid not null references auth.users(id) on delete cascade,
  id         text not null,
  bytes      bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.limits enable row level security;
alter table public.usage_month enable row level security;
alter table public.files enable row level security;
drop policy if exists "read own limits" on public.limits;
create policy "read own limits" on public.limits for select to authenticated using (user_id = auth.uid());
drop policy if exists "read own usage" on public.usage_month;
create policy "read own usage" on public.usage_month for select to authenticated using (user_id = auth.uid());
drop policy if exists "read own files" on public.files;
create policy "read own files" on public.files for select to authenticated using (user_id = auth.uid());

-- The owner (Rafael's account) has no limits
insert into public.limits (user_id, storage_mb, notes_mb, claude_usd_month)
  values ('a5a330b1-0600-4e63-96b5-7441939be21d', null, null, null)
  on conflict (user_id) do nothing;

create or replace function public.add_claude_usage(p_user uuid, p_usd numeric) returns void
language sql security definer set search_path = public as $$
  insert into public.usage_month (user_id, month, claude_usd) values (p_user, to_char(now(), 'YYYY-MM'), p_usd)
  on conflict (user_id, month) do update set claude_usd = usage_month.claude_usd + excluded.claude_usd;
$$;
revoke execute on function public.add_claude_usage(uuid, numeric) from public, anon, authenticated;

-- Notes size guard: no single doc over 8 MB; accounts with a notes limit cannot add docs past it
create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare lim integer; used bigint;
begin
  if pg_column_size(new.data) > 8000000 then raise exception 'doc_too_big'; end if;
  if tg_op = 'INSERT' then
    select notes_mb into lim from public.limits where user_id = new.user_id;
    if not found then lim := 50; end if;
    if lim is not null then
      select coalesce(sum(pg_column_size(data)), 0) into used from public.docs where user_id = new.user_id;
      if used > lim::bigint * 1048576 then raise exception 'notes_full'; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs
  for each row execute function public.docs_guard();

-- Supabase picture storage: everyone keeps reading and deleting their own pictures,
-- but only accounts without a picture limit (the owner) may still upload there; everyone else uploads to R2.
drop policy if exists "own assets" on storage.objects;
drop policy if exists "own assets read" on storage.objects;
drop policy if exists "own assets delete" on storage.objects;
drop policy if exists "owner assets write" on storage.objects;
drop policy if exists "owner assets update" on storage.objects;
create policy "own assets read" on storage.objects for select to authenticated
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own assets delete" on storage.objects for delete to authenticated
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owner assets write" on storage.objects for insert to authenticated
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text
    and exists (select 1 from public.limits l where l.user_id = auth.uid() and l.storage_mb is null));
create policy "owner assets update" on storage.objects for update to authenticated
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text
    and exists (select 1 from public.limits l where l.user_id = auth.uid() and l.storage_mb is null));
