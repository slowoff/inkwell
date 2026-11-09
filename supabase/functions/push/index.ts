// Inkwell homework reminders (1.93): web push to the person's phone (or any device that turned reminders on).
// verify_jwt is off: app calls are checked with getUser, the every-minute cron call with the key in public.push_conf.
//   key   (signed in)  -> {pub}: VAPID public key for pushManager.subscribe (made and stored on first use)
//   sub   (signed in)  {sub: {endpoint, keys: {p256dh, auth}}, dev} -> {ok}: this device gets reminders
//   unsub (signed in)  {endpoint} -> {ok}
//   test  (signed in)  {endpoint} -> {status}: a "reminders are on" notification to that device now
//   due   (cron, header x-cron-key) -> {sent, gone}: sends every due reminder (public.push_due) once
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { makeVapid, send } from "./webpush.js";

const envKey = (json: string, legacy: string): string => {
  try { const k = JSON.parse(Deno.env.get(json) || "{}").default; if (k) return k; } catch { /* not set */ }
  return Deno.env.get(legacy)!;
};
const URL_ = Deno.env.get("SUPABASE_URL")!;
const PUB_KEY = () => envKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
const SECRET_KEY = () => envKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
const bearer = (h: string) => /^Bearer\s+(.+)$/i.exec(h)?.[1] || "";
const SUBJECT = "https://slowoff.github.io/inkwell/";

const ORIGINS = ["https://slowoff.github.io", "http://localhost:8765", "http://127.0.0.1:8765", "http://localhost:8766", "http://127.0.0.1:8766"];
const cors = (req: Request) => {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

const admin = () => createClient(URL_, SECRET_KEY(), { auth: { persistSession: false } });

async function conf(db: ReturnType<typeof admin>, k: string): Promise<string | null> {
  const { data } = await db.from("push_conf").select("v").eq("k", k).maybeSingle();
  return data ? data.v : null;
}
let vapidCache: { pub: string; jwk: JsonWebKey } | null = null;
async function vapid(db: ReturnType<typeof admin>) {
  if (vapidCache) return vapidCache;
  let pub = await conf(db, "vapid_pub"), jwk = await conf(db, "vapid_jwk");
  if (!pub || !jwk) {
    const v = await makeVapid();
    // two first calls at once: only one pair is kept, both read it back
    await db.from("push_conf").upsert([{ k: "vapid_pub", v: v.pub }, { k: "vapid_jwk", v: JSON.stringify(v.jwk) }], { onConflict: "k", ignoreDuplicates: true });
    pub = await conf(db, "vapid_pub"); jwk = await conf(db, "vapid_jwk");
  }
  if (!pub || !jwk) throw new Error("no VAPID key");
  vapidCache = { pub, jwk: JSON.parse(jwk) };
  return vapidCache;
}

// "Tue 10 Nov" from "2026-11-10" (a date without a time zone)
const dayText = (d: string | null) => {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
};

type Sub = { endpoint: string; p256dh: string; auth: string };
const asSub = (s: Sub) => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method" });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action || "");
  const db = admin();

  if (action === "due") {
    const key = req.headers.get("x-cron-key") || "", want = await conf(db, "cron");
    if (!want || key !== want) return json(req, 403, { error: "forbidden" });
    const { data: rows, error } = await db.rpc("push_due");
    if (error) return json(req, 500, { error: error.message });
    const v = await vapid(db);
    let sent = 0, gone = 0;
    const subsOf = new Map<string, Sub[]>();
    for (const r of (rows || []) as { user_id: string; id: string; txt: string; due: string | null; remind: number }[]) {
      if (!subsOf.has(r.user_id)) {
        const { data } = await db.from("push_subs").select("endpoint,p256dh,auth").eq("user_id", r.user_id);
        subsOf.set(r.user_id, (data || []) as Sub[]);
      }
      const due = dayText(r.due);
      const payload = JSON.stringify({
        title: "Homework" + (due ? " · due " + due : ""),
        body: r.txt || "Homework",
        id: r.id, tag: "hw-" + r.id,
      });
      // marked first, so a slow or failing push service never sends the same reminder twice
      const { error: e2 } = await db.from("hw_sent").insert({ user_id: r.user_id, id: r.id, remind: r.remind });
      if (e2) { console.warn("hw_sent", e2.message); continue; }
      for (const s of subsOf.get(r.user_id) || []) {
        try {
          const res = await send(asSub(s), payload, v, SUBJECT);
          if (res.status === 404 || res.status === 410) {
            await db.from("push_subs").delete().eq("user_id", r.user_id).eq("endpoint", s.endpoint); gone++;
          } else if (res.status >= 200 && res.status < 300) sent++;
          else console.warn("push", res.status, res.text);
        } catch (e) { console.warn("push failed", String(e)); }
      }
    }
    return json(req, 200, { sent, gone, due: (rows || []).length });
  }

  // everything else: a signed-in person
  const tok = bearer(req.headers.get("authorization") || "");
  if (!tok) return json(req, 401, { error: "not_signed_in" });
  const { data: u } = await createClient(URL_, PUB_KEY(), { auth: { persistSession: false } }).auth.getUser(tok);
  const user = u && u.user;
  if (!user) return json(req, 401, { error: "not_signed_in" });

  if (action === "key") return json(req, 200, { pub: (await vapid(db)).pub });

  if (action === "sub") {
    const s = (body.sub || {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const ep = String(s.endpoint || ""), p = String(s.keys?.p256dh || ""), a = String(s.keys?.auth || "");
    if (!/^https:\/\/[^\s]{8,1000}$/.test(ep) || !/^[A-Za-z0-9_-]{80,100}$/.test(p) || !/^[A-Za-z0-9_-]{16,32}$/.test(a))
      return json(req, 400, { error: "bad_subscription" });
    const { count } = await db.from("push_subs").select("endpoint", { count: "exact", head: true }).eq("user_id", user.id);
    if ((count || 0) >= 10) {   // at most 10 devices: the oldest goes
      const { data: old } = await db.from("push_subs").select("endpoint").eq("user_id", user.id).order("created_at").limit(1);
      if (old && old[0]) await db.from("push_subs").delete().eq("user_id", user.id).eq("endpoint", old[0].endpoint);
    }
    const { error } = await db.from("push_subs").upsert({ user_id: user.id, endpoint: ep, p256dh: p, auth: a, dev: String(body.dev || "").slice(0, 80) }, { onConflict: "user_id,endpoint" });
    if (error) return json(req, 500, { error: error.message });
    return json(req, 200, { ok: true });
  }

  if (action === "unsub") {
    await db.from("push_subs").delete().eq("user_id", user.id).eq("endpoint", String(body.endpoint || ""));
    return json(req, 200, { ok: true });
  }

  if (action === "test") {
    const { data } = await db.from("push_subs").select("endpoint,p256dh,auth").eq("user_id", user.id).eq("endpoint", String(body.endpoint || "")).maybeSingle();
    if (!data) return json(req, 404, { error: "not_subscribed" });
    const res = await send(asSub(data as Sub), JSON.stringify({ title: "Inkwell", body: "Homework reminders are on for this device.", tag: "hw-test" }), await vapid(db), SUBJECT);
    if (res.status === 404 || res.status === 410) await db.from("push_subs").delete().eq("user_id", user.id).eq("endpoint", (data as Sub).endpoint);
    return json(req, 200, { status: res.status });
  }

  return json(req, 400, { error: "unknown_action" });
});
