import { getStore } from "@netlify/blobs";

// Remembers which booking time slots are taken so two customers can't book the same time.
// Slots: 10 = 10 AM-12 PM, 12 = 12-2 PM, 14 = 2-4 PM (weekends only).
const OWNER_KEY_SHA256 = "e0acbf01ce6e496d90b971f0d9555ee115384fbaf5b8a5d0df14d0d46e550ac3";
const HOURS = [10, 12, 14];

const store = () => getStore({ name: "bookings", consistency: "strong" });
const validDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const validHour = (h) => HOURS.includes(Number(h));
const keyFor = (date, hour) => `${date}_${Number(hour)}`;

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function page(title, msg) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="margin:0;background:#0a0712;color:#f4f0fb;font:18px/1.4 system-ui,sans-serif;padding:32px 20px;text-align:center">` +
      `<h1 style="color:#a855f7">${title}</h1><p>${msg}</p><p><a style="color:#fff" href="/">Back to the website</a></p></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export default async (req) => {
  const url = new URL(req.url);
  const s = store();

  // Owner tools: free up or block a slot (link opened from the private schedule)
  const action = url.searchParams.get("owner");
  if (action) {
    const date = url.searchParams.get("date");
    const hour = url.searchParams.get("hour");
    const key = url.searchParams.get("key") || "";
    if ((await sha256(key)) !== OWNER_KEY_SHA256) return page("Not allowed", "This link is not valid.");
    if (!validDate(date) || !validHour(hour)) return page("Check the link", "That date or time is not valid.");
    if (action === "release") {
      await s.delete(keyFor(date, hour));
      return page("Time reopened", `${date} at ${hour > 12 ? hour - 12 : hour}:00 is open for customers again.`);
    }
    if (action === "block") {
      await s.setJSON(keyFor(date, hour), { blockedByOwner: true, at: new Date().toISOString() });
      return page("Time blocked", `${date} at ${hour > 12 ? hour - 12 : hour}:00 now shows as booked on the website.`);
    }
    return page("Check the link", "Unknown action.");
  }

  // Customer: which slots are taken on a day
  if (req.method === "GET") {
    const date = url.searchParams.get("date");
    if (!validDate(date)) return Response.json({ error: "bad date" }, { status: 400 });
    const taken = [];
    for (const h of HOURS) if ((await s.get(keyFor(date, h))) !== null) taken.push(h);
    return Response.json({ taken }, { headers: { "cache-control": "no-store" } });
  }

  // Customer: reserve a slot
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
    const { date, hour } = body || {};
    if (!validDate(date) || !validHour(hour)) return Response.json({ error: "bad slot" }, { status: 400 });
    const token = crypto.randomUUID();
    const record = {
      name: String(body.name || "").slice(0, 80),
      phone: String(body.phone || "").slice(0, 30),
      token,
      at: new Date().toISOString(),
    };
    const { modified } = await s.setJSON(keyFor(date, hour), record, { onlyIfNew: true });
    if (!modified) return Response.json({ ok: false, taken: true }, { status: 409 });
    return Response.json({ ok: true, token });
  }

  // Customer: undo their own hold (they tapped "Change my booking")
  if (req.method === "DELETE") {
    let body;
    try { body = await req.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
    const { date, hour, token } = body || {};
    if (!validDate(date) || !validHour(hour) || !token) return Response.json({ error: "bad request" }, { status: 400 });
    const cur = await s.get(keyFor(date, hour), { type: "json" });
    if (cur && cur.token === token) await s.delete(keyFor(date, hour));
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/slots" };
