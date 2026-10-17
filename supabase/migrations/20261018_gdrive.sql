-- Inkwell 1.30: pictures can live in the person's own Google Drive.
-- gdrive: one row per account that connected Google Drive. Only the server functions read it (no policies = no client access).
create table if not exists public.gdrive (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  folder_id     text,
  email         text,
  on_new        boolean not null default true,    -- new pictures go to Drive
  broken        boolean not null default false,   -- Google refused the saved sign-in; the person has to connect again
  created_at    timestamptz not null default now()
);
alter table public.gdrive enable row level security;

-- where each picture lives: 'r2' (shared Inkwell cloud) or 'gdrive' (the person's own Drive, gid = Drive file id)
alter table public.files add column if not exists place text not null default 'r2';
alter table public.files add column if not exists gid text;

-- only pictures in the shared cloud count towards its total
create or replace function public.files_total() returns bigint
language sql security definer set search_path = public as $$ select coalesce(sum(bytes), 0)::bigint from public.files where place = 'r2' $$;
revoke execute on function public.files_total() from public, anon, authenticated;
