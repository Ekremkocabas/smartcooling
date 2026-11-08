// netlify/functions/kras-claim.js  (v1, 8/11/2026)
// Kraskaart-actie (/kras/). De korting wordt HIER op de server bepaald, nooit in de browser.
// Schema (Ekrem, 8/11): per reeks van 11 deelnemers -> 5× € 50, 3× € 75, 1× € 100, 1× € 125, 1× € 150,
// volgorde per reeks geschud (niet voorspelbaar). Gemiddeld ± € 77 per deelnemer.
// Enkel geldige, unieke deelnemers tellen (1 per e-mail én 1 per gsm). Wie opnieuw deelneemt,
// krijgt zijn bestaande code terug. Lead -> Odoo + lead-mail (via lead-process-background),
// klant krijgt zijn code per mail (Brevo).
// Opslag: Netlify Blobs, store "kras" (geen extra database nodig).
const crypto = require("crypto");
const { getStore, connectLambda } = require("@netlify/blobs");

const END = () => process.env.KRAS_END || "2026-12-31";
const SALT = () => process.env.KRAS_SALT || crypto.createHash("sha256").update("kras:" + (process.env.ODOO_API_KEY || "sc")).digest("hex");
const leadToken = () => crypto.createHash("sha256").update("lead:" + (process.env.ODOO_API_KEY || "")).digest("hex");
const h = (s) => crypto.createHmac("sha256", SALT()).update(String(s)).digest("hex").slice(0, 32);

const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });

// ---- Kortingsschema ----
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let x = parseInt(crypto.createHmac("sha256", SALT()).update("cycle:" + seed).digest("hex").slice(0, 8), 16) || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const REEKS = [50, 50, 50, 50, 50, 75, 75, 75, 100, 125, 150];
function amountFor(n) {
  const i = n - 1, k = Math.floor(i / REEKS.length);
  return seededShuffle(REEKS, "r11:" + k)[i % REEKS.length];
}

// ---- Validatie ----
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, max || 120);
function normGsm(g) {
  let d = String(g || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+32")) d = "0" + d.slice(3);
  else if (d.startsWith("0032")) d = "0" + d.slice(4);
  return /^04\d{8}$/.test(d) ? d : null;          // Belgisch gsm-nummer
}
const okMail = (e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e);
const okPost = (p) => /^[1-9]\d{3}$/.test(p);
function makeCode(amount) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; const b = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) s += abc[b[i] % abc.length];
  return `SC-${s}-${amount}`;
}
const geldigTot = () => { const [y, m, d] = END().split("-"); return `${d}/${m}/${y}`; };

// ---- Mail naar de klant ----
async function mailKlant(d) {
  const key = process.env.BREVO_API_KEY; if (!key) return false;
  const from = process.env.LEAD_MAIL_FROM || "info@smartcooling.be";
  const html = `<!doctype html><html><body style="margin:0;background:#EEF3F7;font-family:Arial,Helvetica,sans-serif;color:#0A1622">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#0A1622;padding:20px 28px"><img src="https://smartcooling.be/assets/logo.png" alt="Smart Cooling" width="150" style="display:block"></td></tr>
<tr><td style="padding:28px">
<p style="font-size:16px;margin:0 0 14px">Dag ${d.voornaam ? String(d.voornaam).replace(/[<>&]/g, "") : ""},</p>
<p style="font-size:16px;margin:0 0 18px">Proficiat! U hebt met de Smart Cooling-kraskaart gewonnen:</p>
<div style="background:#FFF8E1;border:2px dashed #C9A227;border-radius:12px;padding:20px;text-align:center;margin:0 0 18px">
<div style="font-size:32px;font-weight:bold;color:#0A1622">€ ${d.korting} extra korting</div>
<div style="font-size:15px;margin-top:8px">op uw airco met plaatsing</div>
<div style="font-size:22px;font-weight:bold;letter-spacing:2px;margin-top:14px;color:#1B6FB3">${d.code}</div></div>
<p style="font-size:15px;margin:0 0 10px">Wij bellen u binnenkort voor een gratis plaatsbezoek. Uw korting staat al bij uw aanvraag; vermeld gerust uw code.</p>
<p style="font-size:13px;color:#5B6F80;margin:0 0 18px">Geldig voor een offerte aangevraagd tot en met ${d.geldig_tot}, bij een airco met plaatsing door Smart Cooling. 1 code per adres, niet cumuleerbaar met andere acties, niet inwisselbaar voor geld.</p>
<p style="margin:0 0 6px"><a href="https://www.instagram.com/smartcooling.be/" style="display:inline-block;background:#46B4E8;color:#0A1622;text-decoration:none;font-weight:bold;border-radius:999px;padding:12px 22px">Volg ons op Instagram</a></p>
<p style="font-size:13px;color:#5B6F80;margin:14px 0 0">Vragen? Antwoord gewoon op deze mail of stuur ons een WhatsApp: +32 470 96 11 21.</p>
</td></tr>
<tr><td style="padding:14px 28px;background:#0A1622;color:#9FB3C4;font-size:12px">Smart Cooling · Lochtemanweg 96, 3550 Heusden-Zolder · erkend koeltechnisch bedrijf ENREF/03568</td></tr>
</table></td></tr></table></body></html>`;
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST", headers: { "api-key": key, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ sender: { name: "Smart Cooling", email: from }, to: [{ email: d.email, name: [d.voornaam, d.naam].filter(Boolean).join(" ") || d.email }], replyTo: { email: from }, subject: `Uw kraskaart: € ${d.korting} extra korting (${d.code})`, htmlContent: html, tags: ["kras"] }),
  });
  if (!res.ok) throw new Error("Brevo klantmail " + res.status + ": " + (await res.text()).slice(0, 200));
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Methode niet toegelaten" });
  let b = {};
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Ongeldige aanvraag" }); }
  if (b.website) return json(200, { ok: false, error: "Ongeldige aanvraag" });   // honeypot
  if (new Date() > new Date(END() + "T23:59:59+01:00")) return json(410, { ok: false, error: "De kraskaart-actie is afgelopen." });

  const d = {
    voornaam: clean(b.voornaam, 60), naam: clean(b.naam, 80), email: clean(b.email, 120).toLowerCase(),
    gsm: normGsm(b.gsm), postcode: clean(b.postcode, 4), gemeente: clean(b.gemeente, 60),
    interesse: clean(b.interesse, 80), wanneer: clean(b.wanneer, 60), utm: clean(b.utm, 200), bron_pagina: clean(b.bron || "/kras/", 120),
  };
  const fouten = [];
  if (!d.voornaam) fouten.push("voornaam");
  if (!okMail(d.email)) fouten.push("e-mail");
  if (!d.gsm) fouten.push("gsm (Belgisch nummer, 04..)");
  if (!okPost(d.postcode)) fouten.push("postcode");
  if (!b.akkoord) fouten.push("akkoord met de voorwaarden");
  if (fouten.length) return json(400, { ok: false, error: "Controleer: " + fouten.join(", ") });

  connectLambda(event);
  const store = getStore({ name: "kras", consistency: "strong" });
  const kE = "e/" + h(d.email), kP = "p/" + h(d.gsm);

  // Al deelgenomen? Dan dezelfde code terug.
  const [oudE, oudP] = await Promise.all([store.get(kE, { type: "json" }), store.get(kP, { type: "json" })]);
  const oud = oudE || oudP;
  if (oud) return json(200, { ok: true, again: true, korting: oud.korting, code: oud.code, geldig_tot: oud.geldig_tot });

  // Volgnummer: unieke tijd-sleutel wegschrijven, daarna onze positie in de gesorteerde lijst.
  const ts = Date.now().toString().padStart(14, "0") + "-" + crypto.randomBytes(3).toString("hex");
  await store.setJSON("c/" + ts, { t: Date.now() });
  const { blobs } = await store.list({ prefix: "c/" });
  const keys = blobs.map((x) => x.key).sort();
  const nummer = keys.indexOf("c/" + ts) + 1 || keys.length;

  const korting = amountFor(nummer);
  const code = makeCode(korting);
  const rec = { korting, code, nummer, geldig_tot: geldigTot(), t: new Date().toISOString() };
  await Promise.all([store.setJSON(kE, rec), store.setJSON(kP, rec), store.setJSON("r/" + code, { ...rec, gemeente: d.gemeente, postcode: d.postcode })]);
  console.log("kras: deelnemer", nummer, "→ €", korting, code);

  const lead = { ...d, korting, code, nummer, geldig_tot: rec.geldig_tot };
  const base = process.env.URL || "https://smartcooling.be";
  // Odoo + lead-mail (background, met pogingen) en klantmail parallel; fouten blokkeren de klant niet.
  await Promise.allSettled([
    fetch(base + "/.netlify/functions/lead-process-background", { method: "POST", headers: { "Content-Type": "application/json", "x-lead-token": leadToken() }, body: JSON.stringify({ payload: { form_name: "kras", data: lead } }) })
      .then((r) => console.log("kras lead → background", r.status)).catch((e) => console.error("kras background fout:", e.message)),
    mailKlant(lead).then(() => console.log("kras klantmail verstuurd")).catch((e) => console.error("kras klantmail fout:", e.message)),
  ]);
  return json(200, { ok: true, korting, code, geldig_tot: rec.geldig_tot });
};
exports._amountFor = amountFor;
