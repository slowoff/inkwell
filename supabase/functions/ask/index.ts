// Inkwell "Ask Claude" proxy. Keeps the Anthropic API key on the server and only lets allowed accounts use it.
// Secrets (Supabase dashboard -> Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY   key from console.anthropic.com
//   ASK_ALLOWED_EMAILS  comma-separated emails of Inkwell accounts that may use Claude
//   ASK_MODEL           optional, the strong model, defaults to claude-sonnet-5-5
//   ASK_FAST_MODEL      optional, the cheap model, defaults to claude-haiku-5-5
// Spending (since 1.27): every call's cost is added to public.usage_month; accounts with a monthly cap
// (public.limits.claude_usd_month, default USD 2 for accounts without a limits row, null = no cap) get 402 limit_reached.
// Body: {mode: 'tutor'|'solve'|'practice', model: 'auto'|'fast'|'smart', messages}. 'auto' lets the cheap model decide first.
// Background jobs (fixed model, no chat): mode 'read' = transcribe handwriting for search (fast model),
// mode 'latex' = turn a handwritten formula into LaTeX (smart model), mode 'ocr' = read an imported page
// picture for search (fast model), mode 'scribe' = handwriting -> typed text box (fast model).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Supabase keys (1.35): the new publishable/secret keys (JSON by name, "default"), falling back to the legacy anon/service_role
// keys, which Supabase switches off at the end of 2026. verify_jwt is off for this function; it checks the user itself.
const envKey = (json: string, legacy: string): string => {
  try { const k = JSON.parse(Deno.env.get(json) || "{}").default; if (k) return k; } catch { /* not set */ }
  return Deno.env.get(legacy)!;
};
const PUB_KEY = () => envKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
const SECRET_KEY = () => envKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
const bearer = (h: string) => /^Bearer\s+(.+)$/i.exec(h)?.[1] || "";

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

const BASE = `You are Claude, built into Inkwell, the iPad notes app of a student in Switzerland doing the full-time Berufsmaturität (BM TALS, technical track: maths, physics, chemistry, German, English, French, history, economics). He opens you from a page of his notes and often sends a scanned part of a worksheet; the image may contain his handwriting.

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
  practice: `${BASE}

Mode: PRACTICE. You quiz the student to check whether he really knows the material. His first message contains his learning objectives, exercises and notes (text from his Inkwell pages or files he added) and maybe a focus.
- Base everything on that material. If learning objectives are there, cover them and say which objective each exercise checks.
- Give ONE exercise at a time, then stop and wait for his answer. Number them: Exercise 1, Exercise 2, ...
- Mix the kinds: calculations with new numbers (similar to the given exercises, never copies), short explanations, definitions, "what happens if" questions. Start easy, get harder when he answers well, go back to basics when he struggles.
- Never show the solution before he answers. If he asks for a hint, give a small one.
- When he answers (typed, or a scan of his handwritten work): start with Correct, Partly correct or Wrong, then a short explanation, the right result if he was wrong and the exact step where he went wrong. Then give the next exercise.
- Keep a running score like "Score: 3/4" at the end of each feedback.
- If he says stop, done or enough: give a short summary with the score, which objectives look solid, which need more work and what to review.`,
};

const JOBS: Record<string, { system: string; max: number; smart: boolean }> = {
  read: {
    max: 1500, smart: false,
    system: `You transcribe handwritten notes so they can be searched. The image shows only handwriting (pen strokes) from a student's notes page; it may be in German, English, French or Portuguese and may contain maths.
Output only the words, numbers and formulas you can read, in reading order, as plain text. Write maths in plain LaTeX without $ signs (e.g. v = \\frac{s}{t}). No comments, no explanations, no markdown.
Skip drawings, arrows and scribbles. If nothing is readable, output nothing at all.`,
  },
  ocr: {
    max: 3000, smart: false,
    system: `You transcribe one page of a student's worksheet, textbook or notes (printed text, maybe some handwriting) so it can be searched. It may be in German, English, French or Portuguese.
Output one line of text per line on the page, top to bottom, in reading order (left column before right column). Start every line with its vertical position on the page as a whole percent from the top, then a | character, for example:
12|Aufgabe 3: Ein Auto beschleunigt gleichmässig
Write maths as plain text (v = s/t, x², √2). No comments, no markdown, no explanations. Skip pictures and decoration. If the page has no text at all, output exactly: NO_TEXT`,
  },
  scribe: {
    max: 400, smart: false,
    system: `The image shows handwriting a student just wrote with the Apple Pencil on a notes page. Convert it to typed text exactly as written: the same words, the same line breaks, the same language (German, English, French or Portuguese). Use the context to decide unclear letters, but do not correct grammar and do not rephrase. Write maths as plain text with Unicode (v = s/t, x², √, Δ, ·, →).
Output only the text, nothing else. If the strokes are a drawing, a shape, an arrow, a graph or a scribble and not writing, output exactly: NOT_TEXT`,
  },
  latex: {
    max: 400, smart: true,
    system: `The image shows one handwritten maths or physics expression. Output only the LaTeX for it, with no $ signs, no code fences and no comments. Use \\frac, ^{}, _{}, \\sqrt{}, \\cdot, \\Delta etc. Write units with \\text{} and a thin space, e.g. 9.81\\,\\text{m/s}^2. If it is not readable as maths, output exactly: ?`,
  },
};

// USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, 2026-10-17): [input, output, cache write 5m, cache read]
const PRICES: Record<string, number[]> = {
  "claude-sonnet-5-5": [2, 10, 2.5, 0.1],
  "claude-haiku-5-5": [0.1, 0.5, 0.125, 0.01],
  "claude-opus-5-5": [4, 20, 5, 0.2],
};
const costOf = (model: string, u: any) => {
  const p = PRICES[model] || PRICES["claude-sonnet-5-5"];
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_creation_input_tokens || 0) * p[2] + (u.cache_read_input_tokens || 0) * p[3]) / 1e6;
};

const ROUTER = `You decide which AI model should answer a student's question. Reply with exactly one word.
HARD: reading handwriting or a scanned worksheet with diagrams, graphs or tables; multi-step maths, physics or chemistry calculations; derivations or proofs; checking the student's own work; essay feedback; anything ambiguous or unclear.
EASY: definitions, vocabulary, translations, short factual questions, one-step arithmetic, rephrasing or summarising a short text, simple follow-ups like "thanks" or "explain that again shorter".
When unsure, answer HARD.`;

async function pickModel(key: string, messages: any[], fast: string, smart: string, spent: { usd: number }): Promise<string> {
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
    if (j?.usage) spent.usd += costOf(fast, j.usage);
    const word = String(j?.content?.[0]?.text || "").trim().toUpperCase();
    return word.startsWith("EASY") ? fast : smart;
  } catch { return smart; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return fail(req, 405, "method");

  const auth = req.headers.get("Authorization") || "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, PUB_KEY(), { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await sb.auth.getUser(bearer(auth));
  if (!user) return fail(req, 401, "not_signed_in");
  const allowed = (Deno.env.get("ASK_ALLOWED_EMAILS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes((user.email || "").toLowerCase())) return fail(req, 403, "not_allowed");
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return fail(req, 503, "no_key");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, SECRET_KEY(), { auth: { persistSession: false } });
  const { data: lim } = await admin.from("limits").select("claude_usd_month").eq("user_id", user.id).maybeSingle();
  const cap: number | null = lim ? (lim.claude_usd_month === null ? null : Number(lim.claude_usd_month)) : 2;
  if (cap !== null) {
    const { data: u } = await admin.from("usage_month").select("claude_usd").eq("user_id", user.id).eq("month", new Date().toISOString().slice(0, 7)).maybeSingle();
    if (u && Number(u.claude_usd) >= cap) return fail(req, 402, "limit_reached", `This month's Claude limit (USD ${cap}) is used up. It resets on the 1st.`);
  }
  const spent = { usd: 0 };

  const raw = await req.text();
  if (raw.length > 9_000_000) return fail(req, 413, "too_big");
  let body: { mode?: string; model?: string; messages?: any[] };
  try { body = JSON.parse(raw); } catch { return fail(req, 400, "bad_json"); }
  // long chats: the first message stays (in a practice session it holds the notes), then the latest turns
  const all = Array.isArray(body.messages) ? body.messages : [];
  let messages = all;
  if (all.length > 40) {
    let i = all.length - 38;
    while (i < all.length && all[i]?.role !== "assistant") i++;
    messages = [all[0], ...all.slice(i)];
  }
  if (!messages.length) return fail(req, 400, "no_messages");

  const smart = Deno.env.get("ASK_MODEL") || "claude-sonnet-5-5", fast = Deno.env.get("ASK_FAST_MODEL") || "claude-haiku-5-5";
  const job = JOBS[body.mode || ""];
  const model = job ? (job.smart ? smart : fast) : body.model === "fast" ? fast : body.model === "smart" ? smart : await pickModel(key, messages, fast, smart, spent);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: job ? job.max : 2500,
      stream: true,
      system: job ? job.system : MODES[body.mode || "tutor"] || MODES.tutor,
      messages: job ? messages.slice(-1) : messages,
    }),
  });
  if (!r.ok || !r.body) {
    let msg = "";
    try { const j = await r.json(); msg = j?.error?.message || ""; } catch { /* ignore */ }
    return fail(req, 502, "anthropic_" + r.status, msg || `Claude API error ${r.status}`);
  }
  // pass the stream through unchanged while reading the token counts, then log the cost
  const usage: any = {};
  let buf = "";
  const dec = new TextDecoder();
  const meter = new TransformStream({
    transform(chunk, ctl) {
      ctl.enqueue(chunk);
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("data:") || !line.includes("usage")) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          const u = ev?.message?.usage || ev?.usage;
          if (u) for (const k of Object.keys(u)) if (typeof u[k] === "number") usage[k] = u[k];
        } catch { /* partial or other event */ }
      }
    },
    async flush() {
      const usd = costOf(model, usage) + spent.usd;
      if (usd > 0) { try { await admin.rpc("add_claude_usage", { p_user: user.id, p_usd: usd }); } catch (e) { console.error("usage log", e); } }
    },
  });
  return new Response(r.body.pipeThrough(meter), { headers: { ...cors(req), "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "x-ask-model": model } });
});
