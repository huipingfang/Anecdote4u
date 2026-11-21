// Anecdote backend — Cloudflare Pages _worker.js (Advanced Mode).
//
// Why this file exists: Pages' Direct Upload path (dashboard drag-and-drop
// AND the API direct-upload we deploy with) does NOT compile the functions/
// directory — it's uploaded as inert static files. A _worker.js at the
// project root IS honored by direct upload, but only when sent as the
// special "_worker.bundle" multipart part of the deployment-create request
// (uploaded as a plain asset, it's served as inert JS and never activates).
// So the API lives here instead.
//
// Routing: POST /generate -> the API below; POST /feedback -> feedback inbox;
// everything else -> static assets via the automatic env.ASSETS binding.
// The Anthropic API key lives in the ANTHROPIC_API_KEY secret (set in the
// Cloudflare dashboard), never in this code and never in the app.
// Feedback notes land in the FEEDBACK_KV namespace, bound in wrangler.toml
// (the dashboard manages this git-connected project's bindings through that
// file, not through the dashboard UI).

const MODEL = "claude-haiku-4-5"; // cheap + fast, plenty for short beats
const RATE_LIMIT = 30; // requests per IP per hour — ~15 full sessions, blocks abuse



// On-demand third step: the user asks for angles only when they want them,
// so the first beats call stays small and fast.

// Appended to env.BEATS_PROMPT when the user says "not quite" — asks for a
// genuinely different angle, not a rephrasing of the previous set.

// Simple in-memory sliding-window rate limiter (per isolate; fine at this scale).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const window = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  window.push(now);
  hits.set(ip, window);
  return window.length > RATE_LIMIT;
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Shared-password gate: friends enter the password once in the app; every
// request carries it as the x-app-password header. Compared in constant time.
// If APP_PASSWORD isn't set (e.g. local dev), the gate is off.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function callClaude(env, systemPrompt, userContent, maxTokens) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // trim: pasted secrets sometimes carry invisible trailing whitespace
      "x-api-key": (env.ANTHROPIC_API_KEY || "").trim(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!resp.ok) throw new Error(`anthropic ${resp.status}`);
  const data = await resp.json();
  return ((data.content && data.content[0] && data.content[0].text) || "").trim();
}

function cleanJson(text) {
  return text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
}

// Retry transient Anthropic server errors (5xx) once; client errors like
// bad auth or rate limits fail fast so we don't hammer a bad situation.
async function callClaudeRetry(env, systemPrompt, userContent, maxTokens) {
  try {
    return await callClaude(env, systemPrompt, userContent, maxTokens);
  } catch (e) {
    if (/^anthropic 5/.test((e && e.message) || "")) {
      return await callClaude(env, systemPrompt, userContent, maxTokens);
    }
    throw e;
  }
}

// The model occasionally returns truncated or non-JSON output. Validate
// server-side and retry once before handing the text to the app.
// Note: max_tokens is deliberately tight (the prompt caps output at ~235
// tokens). Longer generations were timing out intermittently; a tight cap
// keeps every attempt fast, and the retry covers the rare truncation.
async function genBeats(env, systemPrompt, material) {
  let text = "";
  for (let i = 0; i < 2; i++) {
    text = cleanJson(await callClaudeRetry(env, systemPrompt, material, 450));
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) return text;
    } catch (e) { /* malformed: retry */ }
  }
  throw new Error("bad_json: " + text.slice(0, 120));
}

// Small failure log (last 20) so flaky generations can be diagnosed from the
// private stats page instead of guessed at. No user content, just the action
// and the error.
async function logFail(env, action, message) {
  try {
    const raw = await env.FEEDBACK_KV.get("gen_errors");
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift({ t: Date.now(), action, message: (message || "").slice(0, 200) });
    await env.FEEDBACK_KV.put("gen_errors", JSON.stringify(arr.slice(0, 20)));
  } catch (e) { /* logging must never break the request */ }
}

// POST /client-error — { step, kind, ms }. Password-gated. The app calls this
// fire-and-forget when a generation fails on ITS side (network drop, bad
// status, unparseable response) — cases the server never sees, so server logs
// stay empty. Shows up in the stats page "recent errors".
async function handleClientError(request, env) {
  const label = await checkPassword(env, request.headers.get("x-app-password") || "");
  if (!label) return jsonResponse({ error: "Wrong password." }, 401);
  if (!env.FEEDBACK_KV) return jsonResponse({ ok: true });
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: true }); }
  const step = (body.step || "?").toString().slice(0, 20);
  const kind = (body.kind || "?").toString().slice(0, 60);
  const ms = Math.max(0, Math.min(9999999, parseInt(body.ms, 10) || 0));
  await logFail(env, step, "client: " + kind + " after " + ms + "ms");
  return jsonResponse({ ok: true });
}

// POST /generate
//   { "action": "question", "what": "..." }            -> { "question": "..." }
//   { "action": "beats", "what": "...", "answer": "" }  -> [{"tag":"hook","text":"..."}, ...]
//   { "action": "regenerate", ... }                    -> fresh [{"tag":"...","text":"..."}]
async function handleGenerate(request, env, ctx) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const label = await checkPassword(env, request.headers.get("x-app-password") || "");
  if (!label) {
    if (env.FEEDBACK_KV && ctx) ctx.waitUntil(recordPwBad(env, ip));
    return jsonResponse({ error: "Wrong password." }, 401);
  }
  // Correct password: count the use (bots can't get here). The "don't count
  // this device" switch arrives as x-dnt: 1 and skips recording.
  if (env.FEEDBACK_KV && ctx && request.headers.get("x-dnt") !== "1") {
    ctx.waitUntil(recordPwOk(env, ip, label));
  }

  if (rateLimited(ip)) {
    return jsonResponse({ error: "Rate limit exceeded — try again later." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Bad request." }, 400);
  }

  if (!(env.ANTHROPIC_API_KEY || "").trim()) {
    return jsonResponse({ error: "Server not configured." }, 500);
  }

  try {
    if (body.action === "question") {
      const what = (body.what || "").toString().slice(0, 500).trim();
      if (!what) return jsonResponse({ error: "Tell me what you did first." }, 400);
      const question = await callClaudeRetry(env, env.QUESTION_PROMPT, what, 100);
      if (env.FEEDBACK_KV && ctx && request.headers.get("x-dnt") !== "1") {
        ctx.waitUntil(recordTopic(env, ip, label));
      }
      return jsonResponse({ question });
    }

    if (body.action === "beats") {
      const what = (body.what || "").toString().slice(0, 500).trim();
      const answer = (body.answer || "").toString().slice(0, 2000).trim();
      if (!what) return jsonResponse({ error: "Nothing to work with." }, 400);
      const material = `What's on their mind: ${what}\nTheir answer to the follow-up question: ${answer || "(skipped)"}`;
      const text = await genBeats(env, env.BEATS_PROMPT, material);
      // Pass the model's JSON straight through; the app validates it.
      return new Response(text, { headers: { "Content-Type": "application/json" } });
    }

    if (body.action === "angles") {
      const what = (body.what || "").toString().slice(0, 500).trim();
      const answer = (body.answer || "").toString().slice(0, 2000).trim();
      if (!what) return jsonResponse({ error: "Nothing to work with." }, 400);
      const material = `What's on their mind: ${what}\nTheir answer to the follow-up question: ${answer || "(skipped)"}`;
      const text = await genBeats(env, env.ANGLES_PROMPT, material);
      return new Response(text, { headers: { "Content-Type": "application/json" } });
    }

    if (body.action === "regenerate") {
      const what = (body.what || "").toString().slice(0, 500).trim();
      const answer = (body.answer || "").toString().slice(0, 2000).trim();
      const previous = (body.previous || "").toString().slice(0, 3000);
      if (!what) return jsonResponse({ error: "Nothing to work with." }, 400);
      const material = `What's on their mind: ${what}\nTheir answer to the follow-up question: ${answer || "(skipped)"}\n\nPrevious talking points (take a different angle):\n${previous || "(none)"}`;
      const text = await genBeats(env, env.BEATS_PROMPT + "\n\n" + env.REGENERATE_SUFFIX, material);
      return new Response(text, { headers: { "Content-Type": "application/json" } });
    }

    return jsonResponse({ error: "Unknown action." }, 400);
  } catch (e) {
    if (env.FEEDBACK_KV && ctx) {
      ctx.waitUntil(logFail(env, (body && body.action) || "?", e && e.message));
    }
    return jsonResponse({ error: "Generation failed — try again?" }, 502);
  }
}

// POST /verify — checks the password without generating anything.
// Lets the welcome page reject wrong passwords up front instead of
// bouncing users mid-chat. Returns { ok: true } or 401.
async function handleVerify(request, env, ctx) {
  const label = await checkPassword(env, request.headers.get("x-app-password") || "");
  if (!label) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.FEEDBACK_KV && ctx) ctx.waitUntil(recordPwBad(env, ip));
    return jsonResponse({ error: "Wrong password." }, 401);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) {
    return jsonResponse({ error: "Rate limit exceeded — try again later." }, 429);
  }
  return jsonResponse({ ok: true });
}

// ---- first-party visit stats (private, no cookies, no third parties) ----
// KV schema, key "stats:YYYY-MM-DD" (UTC):
//   { pv:{"/":n,"/chat.html":n}, pw_ok:n, pw_ok_ips:[sha256(ip)..],
//     pw_bad:n, bad_ips:[..], secs:n, secs_ips:[..] }
// pw_ok = authed /generate calls (the password was actually used — bots can't
// fake this). pw_ok_ips = distinct visitors who got in that day. IP hashes are
// one-way; raw IPs are never stored.
function statsKey(d) {
  return "stats:" + (d || new Date()).toISOString().slice(0, 10);
}
function freshStats() {
  return { pv: {}, pw_ok: 0, pw_ok_ips: [], pw_bad: 0, bad_ips: [], secs: 0, secs_ips: [], labels: {}, topics: 0 };
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function getStats(env, key) {
  try {
    const raw = await env.FEEDBACK_KV.get(key);
    const s = raw ? JSON.parse(raw) : null;
    if (s && typeof s === "object") return Object.assign(freshStats(), s);
  } catch { /* fall through */ }
  return freshStats();
}
// Correct password used on /generate (unless the device opted out).
async function recordPwOk(env, ip, label) {
  const key = statsKey();
  const iph = await sha256hex(ip);
  const s = await getStats(env, key);
  s.pw_ok += 1;
  if (!s.pw_ok_ips.includes(iph)) {
    s.pw_ok_ips.push(iph);
    if (s.pw_ok_ips.length > 5000) s.pw_ok_ips = s.pw_ok_ips.slice(-5000);
  }
  const L = s.labels || (s.labels = {});
  const e = L[label] || (L[label] = { uses: 0, ips: [], topics: 0 });
  e.uses += 1;
  if (!e.ips.includes(iph)) {
    e.ips.push(iph);
    if (e.ips.length > 5000) e.ips = e.ips.slice(-5000);
  }
  await env.FEEDBACK_KV.put(key, JSON.stringify(s));
}
// A finished follow-up question = one topic started. This is the intuitive
// unit: one run through the flow fires 2 page views and 2 authed API calls,
// so those counters always read higher than the topic count.
async function recordTopic(env, ip, label) {
  const key = statsKey();
  const s = await getStats(env, key);
  s.topics = (s.topics || 0) + 1;
  const L = s.labels || (s.labels = {});
  const e = L[label] || (L[label] = { uses: 0, ips: [], topics: 0 });
  e.topics = (e.topics || 0) + 1;
  await env.FEEDBACK_KV.put(key, JSON.stringify(s));
}
// Wrong password on /generate — counted once per IP per day so a guessing
// spree can't burn through the KV write quota.
async function recordPwBad(env, ip) {
  const key = statsKey();
  const iph = await sha256hex(ip);
  const s = await getStats(env, key);
  if (s.bad_ips.includes(iph)) return;
  s.bad_ips.push(iph);
  s.pw_bad += 1;
  if (s.bad_ips.length > 5000) s.bad_ips = s.bad_ips.slice(-5000);
  await env.FEEDBACK_KV.put(key, JSON.stringify(s));
}

// POST /ping — { t:"pv", page:"/..." } or { t:"hb", page:"/...", secs:n }.
// Fired by the pages' first-party snippet. Not password-gated (the welcome
// page pings before anyone logs in); the "don't count this device" switch and
// DNT are honored client-side by simply not pinging.
async function handlePing(request, env) {
  if (!env.FEEDBACK_KV) return jsonResponse({ ok: true });
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: true });
  }
  const t = body.t;
  if (t !== "pv" && t !== "hb") return jsonResponse({ ok: true });
  const page = (body.page || "/").toString().slice(0, 64);
  const secs = Math.min(Math.max(parseInt(body.secs, 10) || 0, 0), 3600);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = statsKey();
  const s = await getStats(env, key);
  if (t === "pv") {
    s.pv[page] = (s.pv[page] || 0) + 1;
  } else {
    s.secs += secs;
    const iph = await sha256hex(ip);
    if (!s.secs_ips.includes(iph)) {
      s.secs_ips.push(iph);
      if (s.secs_ips.length > 5000) s.secs_ips = s.secs_ips.slice(-5000);
    }
  }
  await env.FEEDBACK_KV.put(key, JSON.stringify(s));
  return jsonResponse({ ok: true });
}

// GET /stats — last 30 days of daily totals, behind the shared-password gate.
// Powers the private stats.html page.
async function handleStats(request, env) {
  if (env.APP_PASSWORD) {
    const got = request.headers.get("x-app-password") || "";
    if (!timingSafeEqual(got, env.APP_PASSWORD)) {
      return jsonResponse({ error: "Wrong password." }, 401);
    }
  }
  if (!env.FEEDBACK_KV) return jsonResponse({ days: [] });
  const now = new Date();
  const dates = [];
  for (let i = 0; i < 30; i++) {
    dates.push(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  const raws = await Promise.all(dates.map((d) => env.FEEDBACK_KV.get("stats:" + d)));
  // per-person rollup across the window: { label, uses, visitors }
  const peopleMap = {};
  const days = dates.map((date, i) => {
    let s = null;
    try { s = raws[i] ? JSON.parse(raws[i]) : null; } catch { s = null; }
    s = Object.assign(freshStats(), s || {});
    const labels = s.labels || {};
    for (const key of Object.keys(labels)) {
      const e = labels[key] || {};
      const p = peopleMap[key] || (peopleMap[key] = { label: key, uses: 0, topics: 0, ips: {} });
      p.uses += e.uses || 0;
      p.topics += e.topics || 0;
      for (const h of (e.ips || [])) p.ips[h] = 1;
    }
    const pageviews = Object.values(s.pv || {}).reduce((a, b) => a + (b || 0), 0);
    const people = (s.pw_ok_ips || []).length;
    const timed = (s.secs_ips || []).length;
    return {
      date,
      pageviews,
      pw_uses: s.pw_ok || 0,
      topics: s.topics || 0,
      people_in: people,
      bad_pw: s.pw_bad || 0,
      avg_secs: timed ? Math.round((s.secs || 0) / timed) : 0,
    };
  });
  const people = Object.values(peopleMap)
    .map((p) => ({ label: p.label, uses: p.uses, topics: p.topics, visitors: Object.keys(p.ips).length }))
    .sort((a, b) => b.topics - a.topics || b.uses - a.uses);
  let errors = [];
  try { errors = JSON.parse(await env.FEEDBACK_KV.get("gen_errors") || "[]"); } catch (e) {}
  return jsonResponse({ days, people, errors });
}

// ---- per-person passwords ----
// KV key "pwmap": { "<sha256(password)>": "Alex", ... }. Plaintext passwords
// are never stored. The master APP_PASSWORD still works and is attributed to
// "Huiping" in the stats. Returns the label, or null when rejected.
async function getPwMap(env) {
  if (!env.FEEDBACK_KV) return {};
  // NOTE: KV errors propagate (become a 502 "try again"), they must NOT
  // return {} — that would turn a transient store hiccup into a 401 that
  // logs out users with valid passwords.
  return JSON.parse(await env.FEEDBACK_KV.get("pwmap") || "{}") || {};
}
async function checkPassword(env, got) {
  got = got || "";
  const map = await getPwMap(env);
  const hasGate = !!env.APP_PASSWORD || Object.keys(map).length > 0;
  if (!hasGate) return "dev"; // no gate configured (local dev)
  if (env.APP_PASSWORD && timingSafeEqual(got, env.APP_PASSWORD)) return "Huiping";
  if (got) {
    const label = map[await sha256hex(got)];
    if (typeof label === "string" && label) return label;
    // Passwords are minted lowercase now; also accept any casing for older
    // all-lowercase passwords (phones love to capitalize).
    const lower = got.toLowerCase();
    if (lower !== got) {
      const label2 = map[await sha256hex(lower)];
      if (typeof label2 === "string" && label2) return label2;
    }
  }
  return null;
}
function requireMaster(env, request) {
  return !!env.APP_PASSWORD &&
    timingSafeEqual(request.headers.get("x-app-password") || "", env.APP_PASSWORD);
}
// POST /pw-add — { label, password }. Master password only. Mints a per-person
// password; one label keeps one password (re-adding a label replaces its old one).
async function handlePwAdd(request, env) {
  if (!requireMaster(env, request)) return jsonResponse({ error: "Wrong password." }, 401);
  if (!env.FEEDBACK_KV) return jsonResponse({ error: "Password store isn't set up yet." }, 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Bad request." }, 400);
  }
  const label = (body.label || "").toString().trim().toLowerCase().slice(0, 40);
  const password = (body.password || "").toString().trim().toLowerCase();
  if (!label) return jsonResponse({ error: "Give it a name." }, 400);
  if (password.length < 3) return jsonResponse({ error: "Password needs at least 3 characters." }, 400);
  if (timingSafeEqual(password, env.APP_PASSWORD)) {
    return jsonResponse({ error: "That's the master password — pick another." }, 400);
  }
  const map = await getPwMap(env);
  const h = await sha256hex(password);
  if (map[h]) return jsonResponse({ error: "That password is already taken." }, 400);
  for (const k of Object.keys(map)) if (map[k] === label) delete map[k];
  map[h] = label;
  await env.FEEDBACK_KV.put("pwmap", JSON.stringify(map));
  return jsonResponse({ ok: true, label });
}
// POST /pw-del — { label }. Master password only. Revokes that person's password.
async function handlePwDel(request, env) {
  if (!requireMaster(env, request)) return jsonResponse({ error: "Wrong password." }, 401);
  if (!env.FEEDBACK_KV) return jsonResponse({ error: "Password store isn't set up yet." }, 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Bad request." }, 400);
  }
  const label = (body.label || "").toString().trim().toLowerCase();
  const map = await getPwMap(env);
  let removed = 0;
  for (const k of Object.keys(map)) {
    if (map[k] === label) { delete map[k]; removed++; }
  }
  if (!removed) return jsonResponse({ error: "No password under that name." }, 404);
  await env.FEEDBACK_KV.put("pwmap", JSON.stringify(map));
  return jsonResponse({ ok: true, label });
}
// GET /pw-list — labels with passwords minted, master password only.
// (Passwords themselves aren't recoverable — only their labels.)
async function handlePwList(request, env) {
  if (!requireMaster(env, request)) return jsonResponse({ error: "Wrong password." }, 401);
  const map = await getPwMap(env);
  const labels = [...new Set(Object.values(map))].sort();
  return jsonResponse({ labels });
}

// POST /feedback — { "text": "..." }
// Appends the note to the FEEDBACK_KV list. Sits behind the same shared-
// password gate and rate limiter as /generate. Returns 501 when KV isn't
// bound yet, so the app can fail gracefully instead of losing the note
// silently.
async function handleFeedback(request, env, ctx) {
  const label = await checkPassword(env, request.headers.get("x-app-password") || "");
  if (!label) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.FEEDBACK_KV && ctx) ctx.waitUntil(recordPwBad(env, ip));
    return jsonResponse({ error: "Wrong password." }, 401);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) {
    return jsonResponse({ error: "Rate limit exceeded — try again later." }, 429);
  }

  if (!env.FEEDBACK_KV) {
    return jsonResponse({ error: "Feedback isn't set up yet." }, 501);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Bad request." }, 400);
  }
  const text = (body.text || "").toString().trim().slice(0, 2000);
  if (!text) return jsonResponse({ error: "Nothing to save." }, 400);

  const KEY = "feedback";
  let list = [];
  try {
    const raw = await env.FEEDBACK_KV.get(KEY);
    list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  list.push({ ts: Date.now(), text });
  if (list.length > 500) list = list.slice(-500); // keep the store bounded
  await env.FEEDBACK_KV.put(KEY, JSON.stringify(list));
  return jsonResponse({ ok: true });
}

// Stricter limiter for the public access-request form: 5 per IP per hour.
const reqHits = new Map();
function requestLimited(ip) {
  const now = Date.now();
  const w = (reqHits.get(ip) || []).filter((t) => now - t < 3600_000);
  w.push(now);
  reqHits.set(ip, w);
  return w.length > 5;
}

async function readRequests(env) {
  try {
    const raw = await env.FEEDBACK_KV.get("access_requests");
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// POST /request-access — { name, contact, note?, website? }. PUBLIC (no password).
// Appends to the access_requests list for the owner to review on /sitestats.
// `website` is a honeypot: real people never see or fill it, bots do.
async function handleRequestAccess(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (requestLimited(ip)) {
    return jsonResponse({ error: "Too many requests — try again later." }, 429);
  }
  if (!env.FEEDBACK_KV) return jsonResponse({ error: "Requests aren't set up yet." }, 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Bad request." }, 400);
  }
  if (body.website) return jsonResponse({ ok: true }); // honeypot: pretend success
  const name = (body.name || "").toString().trim().slice(0, 60);
  const contact = (body.contact || "").toString().trim().slice(0, 120);
  const note = (body.note || "").toString().trim().slice(0, 300);
  if (!name) return jsonResponse({ error: "Tell us your name." }, 400);
  if (!contact) return jsonResponse({ error: "Add an email or other way to reach you." }, 400);

  const list = await readRequests(env);
  // same contact asking again: refresh the existing entry instead of piling up
  const existing = list.find((r) => r.contact.toLowerCase() === contact.toLowerCase());
  if (existing) {
    Object.assign(existing, { name, note, ts: Date.now() });
  } else {
    list.push({ id: crypto.randomUUID(), ts: Date.now(), name, contact, note });
  }
  await env.FEEDBACK_KV.put("access_requests", JSON.stringify(list.slice(-200)));
  return jsonResponse({ ok: true });
}

// GET /requests-list — master password only.
async function handleRequestsList(request, env) {
  if (!requireMaster(env, request)) return jsonResponse({ error: "Wrong password." }, 401);
  if (!env.FEEDBACK_KV) return jsonResponse({ requests: [] });
  return jsonResponse({ requests: await readRequests(env) });
}

// POST /request-del — { id }. Master password only. Dismisses a request.
async function handleRequestDel(request, env) {
  if (!requireMaster(env, request)) return jsonResponse({ error: "Wrong password." }, 401);
  if (!env.FEEDBACK_KV) return jsonResponse({ error: "Store isn't set up yet." }, 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Bad request." }, 400);
  }
  const list = (await readRequests(env)).filter((r) => r.id !== body.id);
  await env.FEEDBACK_KV.put("access_requests", JSON.stringify(list));
  return jsonResponse({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/generate") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      return handleGenerate(request, env, ctx);
    }
    if (url.pathname === "/ping") {
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      return handlePing(request, env);
    }
    if (url.pathname === "/stats") {
      if (request.method !== "GET") {
        return new Response("Not found", { status: 404 });
      }
      return handleStats(request, env);
    }
    if (url.pathname === "/client-error") {
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      return handleClientError(request, env);
    }
    if (url.pathname === "/verify") {
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      return handleVerify(request, env, ctx);
    }
    if (url.pathname === "/feedback") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      return handleFeedback(request, env, ctx);
    }
    if (url.pathname === "/request-access") {
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      return handleRequestAccess(request, env);
    }
    if (url.pathname === "/requests-list") {
      if (request.method !== "GET") {
        return new Response("Not found", { status: 404 });
      }
      return handleRequestsList(request, env);
    }
    if (url.pathname === "/request-del") {
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      return handleRequestDel(request, env);
    }
    if (url.pathname === "/pw-add") {
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      return handlePwAdd(request, env);
    }
    if (url.pathname === "/pw-del") {
      if (request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      return handlePwDel(request, env);
    }
    if (url.pathname === "/pw-list") {
      if (request.method !== "GET") {
        return new Response("Not found", { status: 404 });
      }
      return handlePwList(request, env);
    }
    // Everything else: serve the static site.
    return env.ASSETS.fetch(request);
  },
};
