// Inkwell pictures in Cloudflare R2 (since 1.27). The R2 key stays on the server; the app gets short-lived links
// that only reach the signed-in person's own folder (<user id>/<asset id>), and uploads are checked against their limit.
// Secrets (Supabase dashboard -> Edge Functions -> Secrets):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   from Cloudflare R2 -> API tokens (Object Read & Write, bucket inkwell-assets)
//   R2_BUCKET   optional, defaults to inkwell-assets
//   R2_TOTAL_MB optional, the cloud total for everyone together, defaults to 9000 MB (below R2's free 10 GB, so it never costs money)
// No limit per person unless public.limits.storage_mb is set for them. When the total is reached, uploads get 413 cloud_full:
// the app then keeps new pictures on the device only and says so. Nothing is ever removed automatically.
// Without the R2 secrets the function answers {r2: false} and the app keeps using Supabase storage.
// Body {action, ...}:
//   info                       -> {r2, used_mb, limit_mb, total_mb, cap_mb, claude_usd, claude_limit}
//   put  {id, size}            -> {url} presigned PUT (15 min), or 413 cloud_full / storage_full
//   get  {ids}                 -> {urls: {id: url|null}} presigned GET for pictures that are in R2 (null = still only in Supabase)
//   del  {ids}                 -> {removed}
//   list                       -> {files: [{id, bytes, created_at}]}
//   migrate {n}                -> copies up to n pictures from Supabase storage to R2 -> {copied, left}
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const ORIGINS = ["https://slowoff.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
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

const DEFAULTS = { storage_mb: null as number | null, claude_usd_month: 2 };
const CAP_MB = Number(Deno.env.get("R2_TOTAL_MB")) || 9000;
const MAX_FILE = 15 * 1048576;
const ID = /^a-[A-Za-z0-9_-]{1,64}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method" });

  const URL_ = Deno.env.get("SUPABASE_URL")!;
  const auth = req.headers.get("Authorization") || "";
  const sb = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json(req, 401, { error: "not_signed_in" });
  const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const acc = Deno.env.get("R2_ACCOUNT_ID"), kid = Deno.env.get("R2_ACCESS_KEY_ID"), sec = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const bucket = Deno.env.get("R2_BUCKET") || "inkwell-assets";
  const r2 = acc && kid && sec ? new AwsClient({ accessKeyId: kid, secretAccessKey: sec, service: "s3", region: "auto" }) : null;
  const objUrl = (id: string) => `https://${acc}.r2.cloudflarestorage.com/${bucket}/${user.id}/${encodeURIComponent(id)}`;
  const presign = async (id: string, method: string) => {
    const u = new URL(objUrl(id));
    u.searchParams.set("X-Amz-Expires", "900");
    const signed = await r2!.sign(new Request(u, { method }), { aws: { signQuery: true } });
    return signed.url;
  };

  let body: any = {};
  try { body = await req.json(); } catch { return json(req, 400, { error: "bad_json" }); }

  const { data: lim } = await admin.from("limits").select("storage_mb, claude_usd_month").eq("user_id", user.id).maybeSingle();
  const storageMb: number | null = lim ? lim.storage_mb : DEFAULTS.storage_mb;
  const totalBytes = async () => {
    const { data, error } = await admin.rpc("files_total");
    if (error) throw error;
    return Number(data) || 0;
  };
  const usedBytes = async () => {
    let total = 0;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("files").select("bytes").eq("user_id", user.id).range(from, from + 999);
      if (error) throw error;
      for (const r of data || []) total += Number(r.bytes) || 0;
      if (!data || data.length < 1000) break;
    }
    return total;
  };

  try {
    switch (body.action) {
      case "info": {
        const month = new Date().toISOString().slice(0, 7);
        const { data: u } = await admin.from("usage_month").select("claude_usd").eq("user_id", user.id).eq("month", month).maybeSingle();
        return json(req, 200, {
          r2: !!r2,
          used_mb: Math.round((await usedBytes()) / 104857.6) / 10,
          limit_mb: storageMb,
          total_mb: Math.round((await totalBytes()) / 104857.6) / 10,
          cap_mb: CAP_MB,
          claude_usd: u ? Number(u.claude_usd) : 0,
          claude_limit: lim ? lim.claude_usd_month : DEFAULTS.claude_usd_month,
        });
      }
      case "put": {
        if (!r2) return json(req, 503, { error: "no_r2" });
        const id = String(body.id || ""), size = Number(body.size) || 0;
        if (!ID.test(id)) return json(req, 400, { error: "bad_id" });
        if (size <= 0 || size > MAX_FILE) return json(req, 413, { error: "file_too_big" });
        const total = await totalBytes();
        if (total + size > CAP_MB * 1048576) return json(req, 413, { error: "cloud_full", total_mb: Math.round(total / 1048576), cap_mb: CAP_MB });
        if (storageMb !== null) {
          const used = await usedBytes();
          if (used + size > storageMb * 1048576) return json(req, 413, { error: "storage_full", used_mb: Math.round(used / 1048576), limit_mb: storageMb });
        }
        const { error } = await admin.from("files").upsert({ user_id: user.id, id, bytes: size }, { onConflict: "user_id,id" });
        if (error) throw error;
        return json(req, 200, { url: await presign(id, "PUT") });
      }
      case "get": {
        const ids: string[] = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x: string) => ID.test(x)).slice(0, 100);
        const urls: Record<string, string | null> = {};
        if (!r2 || !ids.length) return json(req, 200, { urls });
        const { data, error } = await admin.from("files").select("id").eq("user_id", user.id).in("id", ids);
        if (error) throw error;
        const have = new Set((data || []).map((r: any) => r.id));
        for (const id of ids) urls[id] = have.has(id) ? await presign(id, "GET") : null;
        return json(req, 200, { urls });
      }
      case "del": {
        const ids: string[] = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x: string) => ID.test(x)).slice(0, 100);
        if (!r2) return json(req, 503, { error: "no_r2" });
        let removed = 0;
        for (const id of ids) {
          const r = await r2.fetch(objUrl(id), { method: "DELETE" });
          if (r.ok || r.status === 404) {
            await admin.from("files").delete().eq("user_id", user.id).eq("id", id);
            removed++;
          }
        }
        return json(req, 200, { removed });
      }
      case "list": {
        const files: any[] = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await admin.from("files").select("id, bytes, created_at").eq("user_id", user.id).range(from, from + 999);
          if (error) throw error;
          files.push(...(data || []));
          if (!data || data.length < 1000) break;
        }
        return json(req, 200, { files });
      }
      case "migrate": {
        if (!r2) return json(req, 503, { error: "no_r2" });
        const n = Math.max(1, Math.min(12, Number(body.n) || 6));
        const have = new Set<string>();
        for (let from = 0; ; from += 1000) {
          const { data } = await admin.from("files").select("id").eq("user_id", user.id).range(from, from + 999);
          for (const r of data || []) have.add(r.id);
          if (!data || data.length < 1000) break;
        }
        const todo: { name: string; size: number }[] = [];
        for (let off = 0; off < 100000; off += 1000) {
          const { data, error } = await admin.storage.from("assets").list(user.id, { limit: 1000, offset: off });
          if (error) throw error;
          for (const o of data || []) if (o && o.name && ID.test(o.name) && !have.has(o.name)) todo.push({ name: o.name, size: Number(o.metadata?.size) || 0 });
          if (!data || data.length < 1000) break;
        }
        let copied = 0;
        let total = await totalBytes();
        for (const f of todo.slice(0, n)) {
          if (total + f.size > CAP_MB * 1048576) return json(req, 200, { copied, left: todo.length - copied, full: true });
          total += f.size;
          const { data: blob, error } = await admin.storage.from("assets").download(user.id + "/" + f.name);
          if (error || !blob) continue;
          const r = await r2.fetch(objUrl(f.name), { method: "PUT", body: blob, headers: { "Content-Type": blob.type || "image/jpeg" } });
          if (!r.ok) return json(req, 502, { error: "r2_put_" + r.status, message: (await r.text()).slice(0, 300) });
          await admin.from("files").upsert({ user_id: user.id, id: f.name, bytes: blob.size }, { onConflict: "user_id,id" });
          copied++;
        }
        return json(req, 200, { copied, left: Math.max(0, todo.length - copied) });
      }
      default:
        return json(req, 400, { error: "bad_action" });
    }
  } catch (e) {
    return json(req, 500, { error: "server", message: String((e as Error)?.message || e).slice(0, 300) });
  }
});
