// Strava-Anbindung für die Trainingsliste.
// GET  /api/strava                 -> { configured, connected, days, syncedAt }
// GET  /api/strava?code=...        -> Rücksprung von Strava nach der Anmeldung
// POST /api/strava {action:"connect", pin, member}     -> { url } zur Strava-Anmeldung
// POST /api/strava {action:"disconnect", pin, member}  -> trennt die Verbindung
// POST /api/strava {action:"sync"}                     -> holt neue Aktivitäten (höchstens alle 10 Minuten)
import { getStore } from "@netlify/blobs";

const MEMBERS = ["philipp", "aaron", "cedric", "gille", "jannis", "luca", "marcel", "nico", "tom", "tristan"];

// Einstellungen der Wertung
const START = "2026-10-01";          // Strava-Aktivitäten zählen ab diesem Tag
const MIN_SECONDS = 20 * 60;         // kürzere Aktivitäten zählen nicht
const EXCLUDED_TYPES = ["Walk"];     // diese Aktivitätsarten zählen nicht
const THROTTLE_MS = 10 * 60 * 1000;  // so oft darf höchstens bei Strava nachgefragt werden
const STATE_TTL_MS = 15 * 60 * 1000; // so lange gilt der Anmelde-Link

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const config_ = () => {
  const id = Netlify.env.get("STRAVA_CLIENT_ID");
  const secret = Netlify.env.get("STRAVA_CLIENT_SECRET");
  return id && secret ? { id, secret } : null;
};

async function tokenCall(c, params) {
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...params }),
  });
  if (!r.ok) throw Object.assign(new Error("token"), { status: r.status });
  return r.json();
}

// Holt die Aktivitäten einer Person und speichert pro Tag, wie viele zählen.
async function syncMember(s, c, m) {
  let tok = await s.get(`tok/${m}`, { type: "json" });
  if (!tok || tok.broken) return;

  const markBroken = () => s.setJSON(`tok/${m}`, { ...tok, broken: true });
  if (tok.expires - 60 < Math.floor(Date.now() / 1000)) {
    try {
      const t = await tokenCall(c, { grant_type: "refresh_token", refresh_token: tok.refresh });
      tok = { access: t.access_token, refresh: t.refresh_token, expires: t.expires_at };
      await s.setJSON(`tok/${m}`, tok);
    } catch (e) {
      if (e.status === 400 || e.status === 401) await markBroken();
      return;
    }
  }

  // Einen Tag Puffer, weil Strava nach UTC filtert und wir nach Ortszeit zählen.
  const after = Math.floor(Date.parse(START + "T00:00:00Z") / 1000) - 86400;
  const days = {};
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`, {
      headers: { authorization: `Bearer ${tok.access}` },
    });
    if (r.status === 401) { await markBroken(); return; }
    if (!r.ok) return; // zum Beispiel Limit erreicht: alter Stand bleibt
    const list = await r.json();
    for (const a of list) {
      const day = String(a.start_date_local || "").slice(0, 10);
      const type = a.sport_type || a.type;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < START) continue;
      if (EXCLUDED_TYPES.includes(type)) continue;
      if ((a.elapsed_time || 0) < MIN_SECONDS) continue;
      days[day] = (days[day] || 0) + 1;
    }
    if (list.length < 200) break;
  }
  await s.setJSON(`days/${m}`, days);
}

async function publicState(s, configured) {
  const days = {}, connected = {};
  await Promise.all(MEMBERS.map(async (m) => {
    const tok = await s.get(`tok/${m}`, { type: "json" });
    if (!tok) return;
    connected[m] = tok.broken ? "broken" : "ok";
    days[m] = (await s.get(`days/${m}`, { type: "json" })) || {};
  }));
  const meta = (await s.get("strava-meta", { type: "json" })) || {};
  return { configured, connected, days, syncedAt: meta.lastSync || null };
}

async function callback(s, c, url) {
  const home = (q) => Response.redirect(new URL("/?" + q, url.origin).toString(), 302);
  if (!c) return home("strava=error");

  const state = url.searchParams.get("state") || "";
  const rec = /^[a-f0-9]{32}$/.test(state) ? await s.get(`state/${state}`, { type: "json" }) : null;
  if (rec) await s.delete(`state/${state}`);
  if (!rec || Date.now() - rec.ts > STATE_TTL_MS) return home("strava=error");

  if (url.searchParams.get("error")) return home("strava=denied");
  if (!(url.searchParams.get("scope") || "").includes("activity:read")) return home("strava=scope");

  try {
    const t = await tokenCall(c, { code: url.searchParams.get("code") || "", grant_type: "authorization_code" });
    await s.setJSON(`tok/${rec.member}`, { access: t.access_token, refresh: t.refresh_token, expires: t.expires_at });
    await syncMember(s, c, rec.member);
    return home("strava=ok&member=" + rec.member);
  } catch {
    return home("strava=error");
  }
}

export default async (req) => {
  const s = getStore({ name: "fitness", consistency: "strong" });
  const c = config_();
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.has("code") || url.searchParams.has("error")) return callback(s, c, url);
    return json(await publicState(s, !!c));
  }
  if (req.method !== "POST") return json({ error: "Nur GET und POST." }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }

  if (body.action === "sync") {
    if (c) {
      const meta = (await s.get("strava-meta", { type: "json" })) || {};
      if (!meta.lastSync || Date.now() - meta.lastSync > THROTTLE_MS) {
        await s.setJSON("strava-meta", { lastSync: Date.now() });
        await Promise.all(MEMBERS.map((m) => syncMember(s, c, m).catch(() => {})));
      }
    }
    return json(await publicState(s, !!c));
  }

  if (body.action !== "connect" && body.action !== "disconnect") return json({ error: "Unbekannte Aktion." }, 400);

  const pin = Netlify.env.get("GRUPPEN_PIN");
  if (!pin) return json({ error: "Auf Netlify ist noch keine GRUPPEN_PIN eingestellt." }, 500);
  if (String(body.pin || "") !== pin) return json({ error: "PIN stimmt nicht." }, 401);
  const member = String(body.member || "");
  if (!MEMBERS.includes(member)) return json({ error: "Unbekanntes Mitglied." }, 400);

  if (body.action === "connect") {
    if (!c) return json({ error: "Strava ist noch nicht eingerichtet." }, 500);
    const nonce = crypto.randomUUID().replace(/-/g, "");
    await s.setJSON(`state/${nonce}`, { member, ts: Date.now() });
    const auth = new URL("https://www.strava.com/oauth/authorize");
    auth.search = new URLSearchParams({
      client_id: c.id,
      redirect_uri: url.origin + "/api/strava",
      response_type: "code",
      approval_prompt: "auto",
      scope: "activity:read",
      state: nonce,
    }).toString();
    return json({ url: auth.toString() });
  }

  // disconnect
  const tok = await s.get(`tok/${member}`, { type: "json" });
  if (tok && !tok.broken) {
    try {
      await fetch("https://www.strava.com/oauth/deauthorize", { method: "POST", headers: { authorization: `Bearer ${tok.access}` } });
    } catch { /* egal, wir löschen trotzdem */ }
  }
  await s.delete(`tok/${member}`);
  await s.delete(`days/${member}`);
  return json(await publicState(s, !!c));
};

export const config = { path: "/api/strava" };
