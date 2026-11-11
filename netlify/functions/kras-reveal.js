// netlify/functions/kras-reveal.js  (v2, 9/11/2026)
// Stap 1 van de kraskaart: toont het volgende bedrag uit het schema (geen gegevens nodig) + ondertekend token.
// Een geldig bestaand token wordt gewoon teruggegeven (herladen = zelfde bedrag).
const { getStore, connectLambda } = require("@netlify/blobs");
const kras = require("./lib/kras.js");
const json = (c, o) => ({ statusCode: c, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) });
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false });
  if (!kras.actieLoopt()) return json(410, { ok: false, error: "De kraskaart-actie is afgelopen." });
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const t = kras.readToken(b.token); if (t) return json(200, { ok: true, korting: t.a, token: b.token, again: true });
  try { connectLambda(event); const store = getStore("kras"); const r = await kras.reveal(store); return json(200, { ok: true, korting: r.a, token: r.token }); }
  catch (e) { console.error("kras-reveal fout:", e.message); return json(500, { ok: false, error: "Even geen verbinding, probeer opnieuw." }); }
};
