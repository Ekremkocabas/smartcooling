// netlify/functions/submission-created.js  (v8)
// Runs AUTOMATICALLY on every verified Netlify form submission.
// Creates a lead in Odoo CRM for the forms "offerte" and "aircocheck".
// Aircocheck: server-side scoring (kW per ruimte, multisplit, merk-kader, prijsband,
// leadtemperatuur, bron) -> Odoo lead note. Nothing of this is shown to the customer.
//
// Netlify environment variables (Netlify UI, no secrets in this file):
//   ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY
// Optional Odoo custom field (Studio, type Html) on crm.lead:
//   x_studio_aircocheck_html  -> used by the adviesrapport e-mail template.
//   If it does not exist yet, the lead is still created without it.

const WEBSITE_SOURCE_ID = 18;   // utm.source "Website"
const TEAM_SALES = 1;           // Verkoop (Airco)
const TEAM_MONOBLOCK = 4;       // Monoblock
const STAGE_NIEUW = 1;          // "Nieuw Lead"

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nl = (n) => Number(n).toFixed(1).replace(".", ",");

// ---------- Aircocheck scoring ----------
function score(d) {
  let rooms = [];
  try { rooms = JSON.parse(d.ruimtes_json || "[]"); } catch (e) { rooms = []; }
  const kws = rooms.map((r) => Number(r.kw) || 0);
  const total = kws.reduce((a, b) => a + b, 0);
  const mono = /monoblock/i.test(d.systeem || "");
  const wensen = (d.wensen || "").split(",").map((s) => s.trim()).filter(Boolean);
  const has = (w) => wensen.some((x) => x.toLowerCase().startsWith(w.toLowerCase()));

  // systeem-advies (intern)
  let systeem;
  if (mono) systeem = "Monoblock (Nuova Polar)" + (kws.some((k) => k > 4) ? " – LET OP: ruimte > 4 kW, ter plaatse bekijken" : "");
  else if (rooms.length >= 2 && ["1", "Adviseer mij", ""].includes(d.buitenunits || "")) systeem = `Multisplit (${rooms.length} binnenunits, totaal ± ${nl(total)} kW)`;
  else if (kws.some((k) => k > 5)) systeem = "Single split, maar ruimte > 5 kW: multisplit/2 units overwegen";
  else systeem = rooms.length >= 2 ? `${rooms.length} x single split (klant wil ${d.buitenunits} buitenunits)` : "Single split";
  const multiIndex = rooms.length >= 2 ? `${rooms.length} units / ± ${nl(total)} kW` : "-";

  // merk-kader
  const merken = [];
  if (has("Stil") && has("Zuivere lucht")) merken.push("Mitsubishi Electric MSZ-AY / Daikin");
  else if (has("Stil")) merken.push("Mitsubishi Heavy Premium");
  if (has("Zuivere lucht") && !has("Stil")) merken.push("Mitsubishi Electric MSZ-AY / LG ARTCOOL");
  if (has("Hoogste kwaliteit") || has("Laag verbruik")) merken.push("Mitsubishi Heavy Diamond Hyper");
  if (has("Design")) merken.push("LG ARTCOOL Mirror / ME MSZ-LN");
  if (has("Bediening via app") || has("AI-sturing")) merken.push("LG (ThinQ) / Nuova Infinity");
  if (has("Scherpe prijs")) merken.push("Nuova Infinity / LG DUALCOOL WZ");
  if (!merken.length) merken.push("LG Standard Plus / Nuova Infinity (standaard)");
  let tier = 1.0;
  if (has("Hoogste kwaliteit") || has("Laag verbruik") || has("Design")) tier = 1.35;
  else if (has("Stil") || has("Zuivere lucht") || has("AI-sturing")) tier = 1.15;
  if (has("Scherpe prijs") && tier > 1.0) tier -= 0.1;

  // prijsband (intern, incl. plaatsing, ruwe schatting)
  let base = 0;
  if (mono) base = kws.length * 1900;
  else kws.forEach((k) => { base += k <= 3.5 ? 1250 : k <= 5 ? 1550 : 1950; });
  if (rooms.length >= 2 && !mono && /Multisplit/.test(systeem)) base *= 0.92;
  if (wensen.length > 3) base *= 1.1;
  base *= tier;
  const lo = Math.round((base * 0.9) / 50) * 50, hi = Math.round((base * 1.2) / 50) * 50;
  const band = base ? `€ ${lo.toLocaleString("nl-BE")} – € ${hi.toLocaleString("nl-BE")}` : "-";

  // leadtemperatuur
  let pts = 0;
  if (rooms.length >= 2) pts += 2;
  if (has("Hoogste kwaliteit") || has("Laag verbruik")) pts += 1;
  if (d.dagdeel && d.dagdeel !== "Maakt niet uit") pts += 1;
  if (d.locatie === "Bedrijf") pts += 1;
  const dur = Number(d.duur_sec) || 0;
  if (dur > 0 && dur < 600) pts += 1;
  const temp = pts >= 4 ? "HEET" : pts >= 2 ? "WARM" : "LAUW";
  const priority = pts >= 4 ? "3" : pts >= 2 ? "2" : "1";

  // bron / gemeente
  const land = d.landingspagina || "";
  const m = land.match(/^\/airco\/([^/]+)\//);
  const gemeentePagina = m ? m[1] : "-";

  return { rooms, kws, total, systeem, multiIndex, merken, band, temp, priority, gemeentePagina, dur, wensen, mono };
}

function reportHtml(d, s) {
  const td = 'style="padding:9px 12px;border-bottom:1px solid #e3eaf0;vertical-align:top"';
  const th = 'style="padding:9px 12px;border-bottom:1px solid #e3eaf0;vertical-align:top;color:#5B6F80;width:38%"';
  const rows = s.rooms.map((r, i) =>
    `<tr><td ${td}>Ruimte ${i + 1}: ${esc(r.type)} (${esc(r.m2)})</td><td ${td} align="right"><b>&#177; ${nl(r.kw)} kW</b></td></tr>`).join("");
  const info = [
    ["Systeem", d.systeem], ["Waar", d.locatie + (d.bedrijf_type ? " (" + d.bedrijf_type + ")" : "")],
    ["Wensen", d.wensen || "Geen specifieke wensen"], ["Voorkeur dagdeel", d.dagdeel],
    ["Adres", [d.straat, [d.postcode, d.gemeente].filter(Boolean).join(" ")].filter(Boolean).join(", ")],
  ].map(([k, v]) => `<tr><td ${th}>${esc(k)}</td><td ${td}>${esc(v || "-")}</td></tr>`).join("");
  return `<h3 style="font-family:Arial,sans-serif;font-size:17px;margin:0 0 8px;color:#0A1622">Vermogen per ruimte</h3>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:15px;color:#0A1622">${rows}</table>
<p style="font-family:Arial,sans-serif;font-size:13px;color:#5B6F80;margin:8px 0 22px">Eerste inschatting op basis van oppervlakte, ori&#235;ntatie, glas en isolatie. Onze techniekers controleren dit aan de hand van uw foto&#39;s.</p>
<h3 style="font-family:Arial,sans-serif;font-size:17px;margin:0 0 8px;color:#0A1622">Uw gegevens</h3>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:15px;color:#0A1622">${info}</table>`;
}

exports.handler = async (event) => {
  try {
    const payload = JSON.parse(event.body || "{}").payload || {};
    const form = payload.form_name || "offerte";
    if (!["offerte", "aircocheck"].includes(form)) return { statusCode: 200, body: "ignored (other form)" };
    const d = payload.data || {};

    const URL = process.env.ODOO_URL, DB = process.env.ODOO_DB, LOGIN = process.env.ODOO_LOGIN, KEY = process.env.ODOO_API_KEY;
    if (!URL || !DB || !LOGIN || !KEY) { console.error("Missing Odoo env vars"); return { statusCode: 200, body: "missing env vars (logged)" }; }

    const rpc = async (service, method, args) => {
      const res = await fetch(`${URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }) });
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    };
    const uid = await rpc("common", "authenticate", [DB, LOGIN, KEY, {}]);
    if (!uid) throw new Error("Odoo authentication failed (check login/API key)");

    const naam = [d.voornaam, d.naam].filter(Boolean).join(" ").trim();
    const isMono = /monoblock/i.test(d.systeem || "");
    let vals, extra = {};

    if (form === "aircocheck") {
      const s = score(d);
      const description = [
        "AIRCOCHECK via website (smartcooling.be)",
        `Leadtemperatuur: ${s.temp}`,
        "",
        `Systeem (klant): ${d.systeem || "-"}`,
        `Advies (intern): ${s.systeem}`,
        `Multisplit-index: ${s.multiIndex}`,
        `Locatie: ${d.locatie || "-"}${d.locatie === "Bedrijf" ? ` (${d.bedrijf_type || "-"}, ${d.bedrijf_m2 || "?"} m², ${d.bedrijf_personen || "?"} pers., apparatuur ${d.bedrijf_apparatuur || "-"})` : ""}`,
        `Ruimtes: ${(d.ruimtes || "-").split(" | ").join("\n  ")}`,
        `Totaal: ± ${nl(s.total)} kW`,
        `Buitenunits gewenst: ${d.buitenunits || "-"}`,
        `Wensen: ${d.wensen || "-"}`,
        `Merk-kader (intern): ${s.merken.join(" | ")}`,
        `Prijsband (intern, incl. plaatsing): ${s.band}`,
        "",
        `Best bereikbaar: ${d.dagdeel || "-"}`,
        `Bronpagina: ${d.bron_pagina || "-"} · Landingspagina: ${d.landingspagina || "-"} · Gemeentepagina: ${s.gemeentePagina}`,
        `Apparaat: ${d.apparaat || "-"} · Duur: ${s.dur ? Math.round(s.dur / 60) + " min " + (s.dur % 60) + " s" : "-"}`,
      ].join("\n");
      vals = {
        name: `Aircocheck - ${naam || "onbekend"} - ${d.gemeente || ""}`.replace(/ - $/, ""),
        type: "opportunity", contact_name: naam, phone: d.gsm || "", email_from: d.email || "",
        street: d.straat || "", zip: d.postcode || "", city: d.gemeente || "",
        description, priority: s.priority,
        x_studio_is_monoblock: isMono, team_id: isMono ? TEAM_MONOBLOCK : TEAM_SALES,
        stage_id: STAGE_NIEUW, source_id: WEBSITE_SOURCE_ID,
      };
      extra = { x_studio_aircocheck_html: reportHtml(d, s) };
    } else {
      const straat = [d.straat, d.huisnr].filter(Boolean).join(" ").trim();
      const ruimte = Array.isArray(d.ruimte) ? d.ruimte.join(", ") : (d.ruimte || "");
      vals = {
        name: `Website aanvraag - ${naam || "onbekend"}`, type: "opportunity", contact_name: naam,
        phone: d.telefoon || "", email_from: d.email || "", street: straat, zip: d.postcode || "", city: d.gemeente || "",
        description: ["Aanvraag via website (smartcooling.be)", `Bronpagina: ${d.bron_pagina || "-"}`, `Type: ${d.systeem || "-"}`,
          `Aantal airco('s): ${d.aantal || "-"}`, `Gewenste plaatsingsdatum: ${d.plaatsingsdatum || "-"}`,
          `Gewenst belmoment: ${d.belmoment || "-"}`, `Type ruimte: ${ruimte || "-"}`, "", `Bericht: ${d.bericht || "-"}`].join("\n"),
        x_studio_is_monoblock: isMono, team_id: isMono ? TEAM_MONOBLOCK : TEAM_SALES,
        stage_id: STAGE_NIEUW, source_id: WEBSITE_SOURCE_ID,
      };
    }

    let leadId;
    try {
      leadId = await rpc("object", "execute_kw", [DB, uid, KEY, "crm.lead", "create", [{ ...vals, ...extra }]]);
    } catch (e) {
      if (Object.keys(extra).length) {
        console.warn("create with extra fields failed, retrying without:", e.message);
        leadId = await rpc("object", "execute_kw", [DB, uid, KEY, "crm.lead", "create", [vals]]);
      } else throw e;
    }
    console.log("Odoo lead created:", leadId, "form:", form, "monoblock:", isMono);
    return { statusCode: 200, body: JSON.stringify({ ok: true, leadId }) };
  } catch (e) {
    console.error("lead-to-odoo error:", e);
    return { statusCode: 200, body: "error logged" };
  }
};

// exported for local testing
exports._score = score;
