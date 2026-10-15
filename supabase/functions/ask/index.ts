// Inkwell "Ask Claude" proxy. Keeps the Anthropic API key on the server and only lets allowed accounts use it.
// Secrets (Supabase dashboard -> Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY   key from console.anthropic.com
//   ASK_ALLOWED_EMAILS  comma-separated emails of Inkwell accounts that may use Claude
//   ASK_MODEL           optional, the strong model, defaults to claude-sonnet-5-5
//   ASK_FAST_MODEL      optional, the cheap model, defaults to claude-haiku-5-5
// Body: {mode: 'tutor'|'solve', model: 'auto'|'fast'|'smart', messages}. 'auto' lets the cheap model decide first.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ORIGINS = ["https://slowoff.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
const cors = (req: Request) => {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "x-ask-model",
    "Vary": "Origin",
  };
};
const fail = (req: Request, status: number, error: string, message = "") =>
  new Response(JSON.stringify({ error, message }), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

const BASE = `You are Claude, built into Inkwell, the iPad notes app of Rafael, a student in Switzerland doing the full-time Berufsmaturität (BM TALS, technical track: maths, physics, chemistry, German, English, French, history, economics). He opens you from a page of his notes and often sends a scanned part of a worksheet; the image may contain his handwriting.

How to answer:
- Answer in English. Keep German technical terms from the worksheet where they help (e.g. "Beschleunigung (acceleration)").
- Be short and clear. No filler, no praise, no emojis.
- Write maths with LaTeX: $...$ inline, $$...$$ for display. Use SI units with a thin space, e.g. $9.81\\,\\text{m/s}^2$.
- If the image is unreadable or the question is ambiguous, say what you can't read instead of guessing.
- If his handwritten work is visible, check it and point to the exact step that is wrong.`;

const MODES: Record<string, string> = {
  tutor: `${BASE}

Mode: TUTOR. Teach, don't solve:
- Do not give the final answer or the full solution, even if asked in this mode (tell him to switch to Solve for that).
- Name the concept or formula needed, explain it briefly, then give the next step as a hint or a guiding question.
- When he shows a result, say whether it is right; if wrong, give a hint to find the mistake.`,
  solve: `${BASE}

Mode: SOLVE. Give a complete worked solution: given values, formula, steps with units, result (bold), and one line on the idea behind it.`,
};

const ROUTER = `You decide which AI model should answer a student's question. Reply with exactly one word.
HARD: reading handwriting or a scanned worksheet with diagrams, graphs or tables; multi-step maths, physics or chemistry calculations; derivations or proofs; checking the student's own work; essay feedback; anything ambiguous or unclear.
EASY: definitions, vocabulary, translations, short factual questions, one-step arithmetic, rephrasing or summarising a short text, simple follow-ups like "thanks" or "explain that again shorter".
When unsure, answer HARD.`;

async function pickModel(key: string, messages: any[], fast: string, smart: string): Promise<string> {
  try {
    // only the latest question matters for the choice; images in it are cheap for the small model
    const last = messages[messages.length - 1];
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: fast, max_tokens: 5, system: ROUTER, messages: [last] }),
    });
    if (!res.ok) return smart;
    const j = await res.json();
    const word = String(j?.content?.[0]?.text || "").trim().toUpperCase();
    return word.startsWith("EASY") ? fast : smart;
  } catch { return smart; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return fail(req, 405, "method");

  const auth = req.headers.get("Authorization") || "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return fail(req, 401, "not_signed_in");
  const allowed = (Deno.env.get("ASK_ALLOWED_EMAILS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes((user.email || "").toLowerCase())) return fail(req, 403, "not_allowed");
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return fail(req, 503, "no_key");

  const raw = await req.text();
  if (raw.length > 9_000_000) return fail(req, 413, "too_big");
  let body: { mode?: string; model?: string; messages?: any[] };
  try { body = JSON.parse(raw); } catch { return fail(req, 400, "bad_json"); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  if (!messages.length) return fail(req, 400, "no_messages");

  const smart = Deno.env.get("ASK_MODEL") || "claude-sonnet-5-5", fast = Deno.env.get("ASK_FAST_MODEL") || "claude-haiku-5-5";
  const model = body.model === "fast" ? fast : body.model === "smart" ? smart : await pickModel(key, messages, fast, smart);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      stream: true,
      system: MODES[body.mode || "tutor"] || MODES.tutor,
      messages,
    }),
  });
  if (!r.ok || !r.body) {
    let msg = "";
    try { const j = await r.json(); msg = j?.error?.message || ""; } catch { /* ignore */ }
    return fail(req, 502, "anthropic_" + r.status, msg || `Claude API error ${r.status}`);
  }
  return new Response(r.body, { headers: { ...cors(req), "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "x-ask-model": model } });
});
