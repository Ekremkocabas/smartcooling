// netlify/functions/kras-start.js  (v3, 14/11/2026)
// Stap 1 van de kraskaart: klant geeft voornaam, gsm, e-mail en postcode -> deelname wordt meteen vastgelegd
// (bedrag + interne code + nummer). De klant krijgt enkel het bedrag + een sessie-token voor stap 2 (kras-finish).
// Odoo-lead "🎟 Kraskaart €X · gegevens" + lead-mail + klantmail lopen via lead-process-background (3 pogingen).
const crypto = require("crypto");
const { getStore, connectLambda } = require("@netlify/blobs");
const kras = require("./lib/kras.js");
const json = (c, o) => ({ statusCode: c, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) });
const leadToken = () => crypto.createHash("sha256").update("lead:" + (process.env.ODOO_API_KEY || "")).digest("hex");
const clean = (s, n) => String(s == null ? "" : s).replace(/[<>]/g, "").trim().slice(0, n || 80);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false });
  if (!kras.actieLoopt()) return json(410, { ok: false, error: "De kraskaart-actie is afgelopen." });
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  if (b.website) return json(200, { ok: true, korting: 75, sessie: "x" });          // honeypot (bot)
  const d = { voornaam: clean(b.voornaam, 40), gsm: clean(b.gsm, 20), email: clean(b.email, 80).toLowerCase(), postcode: clean(b.postcode, 4) };
  if (!d.voornaam) return json(400, { ok: false, error: "Vul uw voornaam in." });
  const gsmDigits = d.gsm.replace(/[^\d]/g, "");
  if (!/^(\+?32|0)\d{8,9}$/.test(d.gsm.replace(/[\s./-]/g, "")) || gsmDigits.length < 9) return json(400, { ok: false, error: "Vul een geldig Belgisch gsm-nummer in." });
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(d.email)) return json(400, { ok: false, error: "Vul een geldig e-mailadres in." });
  if (!/^[1-9]\d{3}$/.test(d.postcode)) return json(400, { ok: false, error: "Vul een geldige postcode in (4 cijfers)." });
  if (!b.akkoord) return json(400, { ok: false, error: "Vink de voorwaarden aan." });

  let rec, sessie;
  try {
    connectLambda(event); const store = getStore("kras");
    rec = await kras.claimDirect(store, d.email, d.gsm);
    if (rec.fout) return json(410, { ok: false, error: "De kraskaart-actie is afgelopen." });
    sessie = await kras.saveSessie(store, rec.code, d);
  } catch (e) { console.error("kras-start fout:", e.message); return json(500, { ok: false, error: "Even geen verbinding, probeer opnieuw." }); }

  if (rec.nieuw) {
    const payload = { form_name: "kras", data: Object.assign({}, d, { stap: "start", korting: rec.korting, code: rec.code, nummer: rec.nummer, geldig_tot: rec.geldig_tot,
      bron_pagina: clean(b.bron, 120), utm: clean(b.utm, 200), apparaat: clean(b.apparaat, 20) }) };
    const base = process.env.URL || "https://smartcooling.be";
    try {
      const r = await fetch(base + "/.netlify/functions/lead-process-background", { method: "POST", headers: { "Content-Type": "application/json", "x-lead-token": leadToken() }, body: JSON.stringify({ payload }) });
      console.log("kras-start: lead doorgegeven (" + r.status + "), nr " + rec.nummer + ", €" + rec.korting);
    } catch (e) { console.error("kras-start: background niet bereikbaar:", e.message); }
  } else console.log("kras-start: bestaande deelnemer nr " + rec.nummer);
  return json(200, { ok: true, korting: rec.korting, sessie, opnieuw: !rec.nieuw });
};
