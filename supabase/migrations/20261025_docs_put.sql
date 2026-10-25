-- Inkwell 1.60.2: uploads that cannot overwrite another device's newer copy.
-- Before, the app checked the server copy and then uploaded in a second step; when two devices uploaded the
-- same page at almost the same moment, the older copy could overwrite the newer one.
-- docs_put writes each row only if the server copy is still the one the device last saw ("exp"):
--   exp = a server_ts  -> write only if the stored row still has that server_ts (or does not exist)
--   exp = 'new'        -> write only if the row does not exist yet
--   exp missing/null   -> write always (same as the old upsert; used for history, chats, page text, deletes)
-- Returns {ok: [{id, server_ts}], conflict: [id]}. Rows in "conflict" were not written; the app fetches the
-- server copy, merges it and tries again. Runs with the caller's rights, so the "own docs" policy applies.
-- Nothing is deleted or changed in existing tables. Older app versions keep using the plain upsert.
create or replace function public.docs_put(p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  r jsonb;
  uid uuid := auth.uid();
  ok jsonb := '[]'::jsonb;
  bad jsonb := '[]'::jsonb;
  ts timestamptz;
  exp text;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    exp := r->>'exp';
    ts := null;
    if exp is null then
      insert into public.docs as d (user_id, id, kind, data, deleted, updated_at)
      values (uid, r->>'id', r->>'kind', nullif(r->'data', 'null'::jsonb), coalesce((r->>'deleted')::boolean, false), (r->>'updated_at')::bigint)
      on conflict (user_id, id) do update
        set kind = excluded.kind, data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at
      returning d.server_ts into ts;
    elsif exp = 'new' then
      insert into public.docs as d (user_id, id, kind, data, deleted, updated_at)
      values (uid, r->>'id', r->>'kind', nullif(r->'data', 'null'::jsonb), coalesce((r->>'deleted')::boolean, false), (r->>'updated_at')::bigint)
      on conflict (user_id, id) do nothing
      returning d.server_ts into ts;
    else
      insert into public.docs as d (user_id, id, kind, data, deleted, updated_at)
      values (uid, r->>'id', r->>'kind', nullif(r->'data', 'null'::jsonb), coalesce((r->>'deleted')::boolean, false), (r->>'updated_at')::bigint)
      on conflict (user_id, id) do update
        set kind = excluded.kind, data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at
        where d.server_ts = exp::timestamptz
      returning d.server_ts into ts;
    end if;
    if ts is null then bad := bad || to_jsonb(r->>'id');
    else ok := ok || jsonb_build_array(jsonb_build_object('id', r->>'id', 'server_ts', ts));
    end if;
  end loop;
  return jsonb_build_object('ok', ok, 'conflict', bad);
end
$$;

revoke execute on function public.docs_put(jsonb) from public, anon;
grant execute on function public.docs_put(jsonb) to authenticated;
