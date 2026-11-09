-- Inkwell 1.93: homework reminders on the phone (web push). Nothing is deleted from existing tables.
-- push_conf: server-only settings (VAPID keys are made by the push function on first use; the cron key is made here).
-- push_subs: one row per device that turned reminders on. hw_sent: which reminder went out (so it goes out once).
-- A pg_cron job checks every minute whether a reminder is due and only then calls the push function.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create table if not exists public.push_conf (k text primary key, v text not null);
alter table public.push_conf enable row level security;
insert into public.push_conf (k, v) values ('cron', encode(extensions.gen_random_bytes(24), 'hex')) on conflict (k) do nothing;

create table if not exists public.push_subs (
  user_id uuid not null references auth.users on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  dev text,
  created_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);
alter table public.push_subs enable row level security;

create table if not exists public.hw_sent (
  user_id uuid not null,
  id text not null,
  remind bigint not null,
  at timestamptz not null default now(),
  primary key (user_id, id, remind)
);
alter table public.hw_sent enable row level security;

-- server only: no policies, and no table rights for the app's roles
revoke all on public.push_conf, public.push_subs, public.hw_sent from anon, authenticated;

create index if not exists docs_hw on public.docs (user_id) where kind = 'hw';

-- reminders that are due (at most 2 days late), not done, not sent yet, for accounts with a device that turned them on
create or replace function public.push_due()
returns table (user_id uuid, id text, txt text, due text, remind bigint)
language sql stable security definer set search_path = public as $$
  select d.user_id, d.id, left(coalesce(d.data->>'text', ''), 200), d.data->>'due', (d.data->>'remind')::numeric::bigint
  from public.docs d
  where d.kind = 'hw' and not d.deleted and d.data is not null
    and jsonb_typeof(d.data->'remind') = 'number'
    and coalesce(d.data->'done', 'false'::jsonb) <> 'true'::jsonb
    and (d.data->>'remind')::numeric <= extract(epoch from now()) * 1000
    and (d.data->>'remind')::numeric > extract(epoch from now()) * 1000 - 172800000
    and exists (select 1 from public.push_subs s where s.user_id = d.user_id)
    and not exists (select 1 from public.hw_sent h where h.user_id = d.user_id and h.id = d.id and h.remind = (d.data->>'remind')::numeric::bigint)
$$;
create or replace function public.push_pending()
returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from public.push_due()) $$;
revoke execute on function public.push_due(), public.push_pending() from public, anon, authenticated;
grant execute on function public.push_due(), public.push_pending() to service_role;

-- every minute: call the push function only when something is due
select cron.unschedule(jobid) from cron.job where jobname in ('inkwell-homework-push', 'inkwell-cron-cleanup');
select cron.schedule('inkwell-homework-push', '* * * * *', $job$
  select net.http_post(
    url := 'https://pubaedzrgrkjifmiqiew.supabase.co/functions/v1/push',
    body := '{"action":"due"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select v from public.push_conf where k = 'cron')),
    timeout_milliseconds := 20000)
  where public.push_pending()
$job$);
-- once a day: old cron run logs and old sent-markers go (they only keep the job's own bookkeeping)
select cron.schedule('inkwell-cron-cleanup', '17 3 * * *', $job$
  delete from cron.job_run_details where end_time < now() - interval '2 days';
  delete from public.hw_sent where at < now() - interval '30 days';
$job$);
