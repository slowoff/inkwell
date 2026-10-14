-- Inkwell: run this once in Supabase -> SQL Editor -> New query -> Run.

-- 1. Notes table (one row per notebook, section, page, page content or template)
create table if not exists public.docs (
  user_id    uuid    not null default auth.uid() references auth.users(id) on delete cascade,
  id         text    not null,
  kind       text    not null,
  data       jsonb,
  deleted    boolean not null default false,
  updated_at bigint  not null,
  server_ts  timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);
create index if not exists docs_user_server_ts on public.docs (user_id, server_ts);

-- server_ts always comes from the server clock, so devices with wrong clocks still sync
create or replace function public.docs_touch() returns trigger language plpgsql as $$
begin
  new.server_ts := clock_timestamp();
  return new;
end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.docs_touch();

-- Only you can see and change your own notes
alter table public.docs enable row level security;
drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 2. Private storage for imported PDFs and photos
insert into storage.buckets (id, name, public)
  values ('assets', 'assets', false)
  on conflict (id) do nothing;

drop policy if exists "own assets" on storage.objects;
create policy "own assets" on storage.objects for all to authenticated
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);
