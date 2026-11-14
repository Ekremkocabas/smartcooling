// netlify/functions/kras-finish.js  (v3, 14/11/2026)
// Stap 2 van de kraskaart: aantal airco's, m² per ruimte (bij 1–3) en voorkeur merk (optioneel).
// Werkt de bestaande Odoo-lead bij (gevonden via x_kras_code) via lead-process-background.
const crypto = require("crypto");
const { getStore, connectLambda } = require("@netlify/blobs");
const kras = require("./lib/kras.js");
const json = (c, o) => ({ statusCode: c, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) });
const leadToken = () => crypto.createHash("sha256").update("lead:" + (process.env.ODOO_API_KEY || "")).digest("hex");
const MERKEN = ["Daikin", "Mitsubishi", "LG", "Panasonic", "Nuova", "Geen voorkeur"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false });
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  const aantal = ["1", "2", "3", "meer"].includes(String(b.aantal)) ? String(b.aantal) : null;
  if (!aantal) return json(400, { ok: false, error: "Kies hoeveel airco's u wenst." });
  let m2 = [];
  if (aantal !== "meer") {
    m2 = (Array.isArray(b.m2) ? b.m2 : []).slice(0, Number(aantal)).map((x) => Math.round(Number(String(x).replace(",", "."))));
    if (m2.length !== Number(aantal) || m2.some((x) => !(x >= 4 && x <= 300))) return json(400, { ok: false, error: "Vul de oppervlakte van elke ruimte in (in m²)." });
  }
  const merk = MERKEN.includes(b.merk) ? b.merk : "";
  let rec;
  try { connectLambda(event); rec = await kras.recordFromSessie(getStore("kras"), b.sessie); }
  catch (e) { console.error("kras-finish fout:", e.message); return json(500, { ok: false, error: "Even geen verbinding, probeer opnieuw." }); }
  if (!rec) return json(400, { ok: false, error: "Uw sessie is verlopen. Begin opnieuw op smartcooling.be/kras." });

  const k = rec.klant || {};
  const payload = { form_name: "kras", data: { voornaam: k.voornaam, gsm: k.gsm, email: k.email, postcode: k.postcode, stap: "klaar", code: rec.code, korting: rec.korting, nummer: rec.nummer, geldig_tot: rec.geldig_tot,
    aantal, ruimtes_m2: m2.map((x, i) => "Ruimte " + (i + 1) + ": " + x + " m²").join("\n"), merk } };
  const base = process.env.URL || "https://smartcooling.be";
  try {
    const r = await fetch(base + "/.netlify/functions/lead-process-background", { method: "POST", headers: { "Content-Type": "application/json", "x-lead-token": leadToken() }, body: JSON.stringify({ payload }) });
    console.log("kras-finish: doorgegeven (" + r.status + "), nr " + rec.nummer);
  } catch (e) { console.error("kras-finish: background niet bereikbaar:", e.message); }
  return json(200, { ok: true, korting: rec.korting });
};
