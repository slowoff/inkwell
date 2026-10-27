-- Inkwell 1.67.1 (security check 2026-10-27): narrower table rights for the public API roles. Nothing is deleted.
-- Supabase gives anon and authenticated every right on new tables; row-level security is what kept the data private.
-- TRUNCATE, REFERENCES and TRIGGER are not covered by row-level security, and the tables the server functions write
-- (limits, usage_month, files, gdrive) never need writes from the app. These rights are taken back as a second wall.
-- The app only reads limits, usage_month and files (its own rows); docs keeps what sync needs; the keep-alive job
-- reads docs with the publishable key (anon, gets no rows), so anon keeps SELECT on docs.

revoke truncate, references, trigger on public.docs from anon, authenticated;
revoke insert, update, delete on public.docs from anon;

revoke insert, update, delete, truncate, references, trigger on public.limits from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.usage_month from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.files from anon, authenticated;
revoke select on public.limits, public.usage_month, public.files from anon;

-- Google Drive refresh tokens: only the server functions (service role) may touch this table
revoke all on public.gdrive from anon, authenticated;

-- trigger function, never called through the API
revoke execute on function public.docs_touch() from public, anon, authenticated;
