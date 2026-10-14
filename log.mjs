// Speichert die Trainingsliste in Netlify Blobs.
// GET  /api/log  -> { log: { "2026-10-14": ["aaron","philipp","philipp"], ... } }
// POST /api/log  -> Body { pin, date, ids } setzt die Einträge für einen Tag.
import { getStore } from "@netlify/blobs";

const MEMBERS = ["philipp", "aaron", "cedric", "gille", "jannis", "luca", "marcel", "nico", "tom", "tristan"];
const KEY = "log";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default async (req) => {
  const store = getStore({ name: "fitness", consistency: "strong" });

  if (req.method === "GET") {
    const log = (await store.get(KEY, { type: "json" })) || {};
    return json({ log });
  }

  if (req.method !== "POST") return json({ error: "Nur GET und POST." }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }

  const pin = Netlify.env.get("GRUPPEN_PIN");
  if (!pin) return json({ error: "Auf Netlify ist noch keine GRUPPEN_PIN eingestellt." }, 500);
  if (String(body.pin || "") !== pin) return json({ error: "PIN stimmt nicht." }, 401);

  const date = String(body.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Datum fehlt." }, 400);

  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  for (const id of new Set(ids)) {
    if (!MEMBERS.includes(id)) return json({ error: "Unbekanntes Mitglied." }, 400);
    if (ids.filter((x) => x === id).length > 3) return json({ error: "Höchstens 3 Einheiten pro Tag." }, 400);
  }

  const log = (await store.get(KEY, { type: "json" })) || {};
  if (ids.length) log[date] = ids.sort(); else delete log[date];
  await store.setJSON(KEY, log);
  return json({ log });
};

export const config = { path: "/api/log" };
