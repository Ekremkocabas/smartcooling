// netlify/functions/submission-created.js  (v9 — monoblock: richtprijs excl. btw + automatische offerte)
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
// Monoblock (Aircocheck): the customer already saw a richtprijs excl. btw. The function
//   writes the offerte lines into the lead, puts the offerte table in the e-mail html and
//   tries to create a quotation (sale.order) with the matching Odoo products.
//   Set ODOO_AUTO_QUOTE=0 in Netlify to disable quotation creation.

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
  // multisplit: enkel binnenunits die op een multi passen (DUALCOOL WZ is enkel single split)
  if (/^Multisplit/.test(systeem)) {
    for (let i = 0; i < merken.length; i++) merken[i] = merken[i].replace("LG DUALCOOL WZ", "LG Standard Plus");
    if (total > 8.5 || kws.some((k) => k > 5.5)) systeem += " – LET OP: groot vermogen op 1 buitenunit (bv. Nuova 4P-CINF-MS100 of LG MU5R36, ± 10,5 kW); 2 single splits overwegen";
  }
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

// ---------- Monoblock (richtprijs is al aan de klant getoond) ----------
function parseMono(d) {
  try { const m = JSON.parse(d.mono_json || ""); if (m && Array.isArray(m.units)) return m; } catch (e) {}
  return null;
}
const eur = (n) => "€ " + Number(n || 0).toLocaleString("nl-BE");
function monoReportHtml(d, m) {
  const td = 'style="padding:9px 12px;border-bottom:1px solid #e3eaf0;vertical-align:top"';
  const tdr = 'style="padding:9px 12px;border-bottom:1px solid #e3eaf0;vertical-align:top;white-space:nowrap"';
  const rows = (m.lines || []).map((l) => `<tr><td ${td}>${esc(l.t)}</td><td ${tdr} align="right"><b>${l.p == null ? esc(l.txt || "—") : eur(l.p)}</b></td></tr>`).join("");
  const info = [
    ["Systeem", "Monoblock zonder buitenunit (Nuova Polar)"], ["Aantal toestellen", String((m.units || []).filter((u) => u.actief).length)],
    ["Voorkeur dagdeel", d.dagdeel],
    ["Adres", [d.straat, [d.postcode, d.gemeente].filter(Boolean).join(" ")].filter(Boolean).join(", ")],
  ].map(([k, v]) => `<tr><td style="padding:9px 12px;border-bottom:1px solid #e3eaf0;vertical-align:top;color:#5B6F80;width:38%">${esc(k)}</td><td ${td}>${esc(v || "-")}</td></tr>`).join("");
  return `<h3 style="font-family:Arial,sans-serif;font-size:17px;margin:0 0 8px;color:#0A1622">Uw richtprijs</h3>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:15px;color:#0A1622">${rows}
<tr><td style="padding:12px;background:#FFF4E8;font-weight:bold">Richtprijs excl. btw</td><td style="padding:12px;background:#FFF4E8;font-weight:bold;font-size:20px;color:#C2691E;white-space:nowrap" align="right">${eur(m.totaal_excl)}</td></tr></table>
<p style="font-family:Arial,sans-serif;font-size:13px;color:#5B6F80;margin:8px 0 22px">Standaardplaatsing per toestel: boringen, condensafvoer, standaard roosters, aansluiting op het stopcontact, testen en uitleg. Diamantboring droog met stofafzuiging. Alle prijzen excl. btw: 6&nbsp;% btw voor particulieren, 21&nbsp;% voor bedrijven. Definitieve prijs na gratis plaatsbezoek. Meestal binnen 1 week geplaatst.</p>
<h3 style="font-family:Arial,sans-serif;font-size:17px;margin:0 0 8px;color:#0A1622">Uw gegevens</h3>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:15px;color:#0A1622">${info}</table>`;
}

// Odoo-producten zoeken op naam (ilike); niet gevonden -> notitieregel in de offerte
const PRODUCT_KEYS = [
  { re: /Polar\+ 25/i, keys: ["Polar+ 25", "Polar Plus 25", "Polar+"] },
  { re: /Polar Pro 40/i, keys: ["Polar Pro 40", "Polar Pro"] },
  { re: /^Speciale buitenkleppen/i, keys: ["Speciale buitenkleppen", "buitenkleppen"] },
  { re: /^Betonboring/i, keys: ["Betonboring"] },
  { re: /^Speciale roosters/i, keys: ["Speciale roosters"] },
  { re: /^Aparte elektrische lijn/i, keys: ["Aparte elektrische lijn", "voedingskabel"] },
  { re: /^Oud toestel/i, keys: ["Oud toestel"] },
];
async function createQuotation(rpc, DB, uid, KEY, partnerId, leadId, m, naam) {
  if (!partnerId) return null;
  const cache = {};
  const findProduct = async (keys) => {
    for (const k of keys) {
      if (cache[k] !== undefined) { if (cache[k]) return cache[k]; continue; }
      const r = await rpc("object", "execute_kw", [DB, uid, KEY, "product.product", "search_read", [[["name", "ilike", k], ["sale_ok", "=", true]]], { fields: ["id", "name"], limit: 1 }]);
      cache[k] = r && r.length ? r[0].id : null;
      if (cache[k]) return cache[k];
    }
    return null;
  };
  const lines = [];
  for (const l of m.lines || []) {
    const mt = /× (\d+)$/.exec(l.t); const qty = mt ? Number(mt[1]) : 1;
    const def = PRODUCT_KEYS.find((x) => x.re.test(l.t.replace(/^Monoblock \d+: /, "")));
    const pid = def ? await findProduct(def.keys) : null;
    if (pid && l.p != null) lines.push([0, 0, { product_id: pid, product_uom_qty: qty, price_unit: Math.round(l.p / qty), name: l.t }]);
    else if (pid) lines.push([0, 0, { product_id: pid, product_uom_qty: 1, name: l.t + (l.txt ? " – " + l.txt : "") }]);
    else lines.push([0, 0, { display_type: "line_note", name: l.t + (l.p != null ? " – " + eur(l.p) : l.txt ? " – " + l.txt : "") + (def ? " (product niet gevonden in Odoo)" : "") }]);
  }
  lines.push([0, 0, { display_type: "line_note", name: "Richtprijs uit de Aircocheck: " + eur(m.totaal_excl) + " excl. btw. Standaardplaatsing per toestel: boringen, condensafvoer, standaard roosters, aansluiting op stopcontact, testen en uitleg. Definitieve prijs na gratis plaatsbezoek." }]);
  const vals = { partner_id: partnerId, opportunity_id: leadId, origin: "Aircocheck monoblock – " + (naam || ""), order_line: lines };
  try { return await rpc("object", "execute_kw", [DB, uid, KEY, "sale.order", "create", [vals]]); }
  catch (e) { delete vals.opportunity_id; return await rpc("object", "execute_kw", [DB, uid, KEY, "sale.order", "create", [vals]]); }
}

// ---- HTML helpers voor een leesbare notitie in Odoo ----
const ed = (v) => String(v == null || v === "" ? "-" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const row = (k, v) => `<tr><td style="padding:3px 14px 3px 0;color:#5b6b7a;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:3px 0;vertical-align:top">${v}</td></tr>`;
const block = (title, rows) => `<h4 style="margin:14px 0 4px;color:#0A1622">${title}</h4><table style="border-collapse:collapse;font-size:14px">${rows.join("")}</table>`;
const bandMid = (band) => { const n = String(band || "").replace(/\./g, "").match(/\d+/g); if (!n || !n.length) return 0; const a = n.map(Number); return Math.round((Math.min(...a) + Math.max(...a)) / 2); };

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

    const mono = form === "aircocheck" ? parseMono(d) : null;
    if (form === "aircocheck" && mono) {
      const units = (mono.units || []).map((u) => `Monoblock ${u.nr}: ${esc(u.model)} (${esc(u.m2)}, ${esc(u.kw)}) – ${u.actief ? eur(u.prijs) : "<b style=\"color:#B42318\">NIET MOGELIJK: " + esc(u.reden) + "</b>"}`).join("<br>");
      const lines = (mono.lines || []).map((l) => `${esc(l.t)}: <b>${l.p == null ? esc(l.txt || "—") : eur(l.p)}</b>`).join("<br>");
      const description =
        `<p style="font-size:15px;margin:0 0 6px"><b>AIRCOCHECK MONOBLOCK via smartcooling.be</b> &nbsp; <span style="background:#2471a3;color:#fff;border-radius:10px;padding:2px 10px;font-weight:700">RICHTPRIJS GETOOND</span></p>` +
        block("Klant", [row("Naam", ed(naam)), row("Gemeente", ed(d.gemeente)), row("GSM", ed(d.gsm)), row("E-mail", ed(d.email)), row("Best bereikbaar", "<b>" + ed(d.dagdeel) + "</b>")]) +
        block("Toestellen", [row("Monoblocks", units || "-"), row("Controles", ed(d.mono_checks).replace(/ \| /g, "<br>"))]) +
        block("Offerte (zoals getoond aan de klant, excl. btw)", [row("Regels", lines || "-"), row("Richtprijs", "<b>" + eur(mono.totaal_excl) + " excl. btw</b> (6 % particulier / 21 % bedrijf)"), row("Extra's", ed(d.mono_extras))]) +
        block("Herkomst", [row("Bronpagina", ed(d.bron_pagina)), row("Landingspagina", ed(d.landingspagina)), row("Apparaat / duur", ed(d.apparaat) + " · " + (Number(d.duur_sec) ? Math.round(Number(d.duur_sec) / 60) + " min" : "-"))]);
      vals = {
        name: `Aircocheck monoblock - ${naam || "onbekend"} - ${d.gemeente || ""}`.replace(/ - $/, ""),
        type: "opportunity", contact_name: naam, phone: d.gsm || "", email_from: d.email || "",
        street: d.straat || "", zip: d.postcode || "", city: d.gemeente || "",
        description, priority: "2", expected_revenue: Number(mono.totaal_excl) || 0,
        x_studio_is_monoblock: true, team_id: TEAM_MONOBLOCK, stage_id: STAGE_NIEUW, source_id: WEBSITE_SOURCE_ID,
      };
      extra = { x_studio_aircocheck_html: monoReportHtml(d, mono) };
    } else if (form === "aircocheck") {
      const s = score(d);
      const tempKleur = /HEET/i.test(s.temp) ? "#c0392b" : /WARM/i.test(s.temp) ? "#d68910" : "#2471a3";
      const ruimtes = (d.ruimtes || "").split(" | ").filter(Boolean).map(esc).join("<br>") || "-";
      const locatie = ed(d.locatie) + (d.locatie === "Bedrijf" ? ` (${ed(d.bedrijf_type)}, ${ed(d.bedrijf_m2)} m², ${ed(d.bedrijf_personen)} pers., apparatuur ${ed(d.bedrijf_apparatuur)})` : "");
      const description =
        `<p style="font-size:15px;margin:0 0 6px"><b>AIRCOCHECK via smartcooling.be</b> &nbsp; <span style="background:${tempKleur};color:#fff;border-radius:10px;padding:2px 10px;font-weight:700">${ed(s.temp)}</span></p>` +
        block("Klant", [
          row("Naam", ed(naam)), row("Gemeente", ed(d.gemeente)), row("GSM", ed(d.gsm)), row("E-mail", ed(d.email)),
          row("Best bereikbaar", "<b>" + ed(d.dagdeel) + "</b>"),
        ]) +
        block("Wat wil de klant?", [
          row("Systeem", "<b>" + ed(d.systeem) + "</b>"), row("Locatie", locatie), row("Ruimtes", ruimtes),
          row("Totaal vermogen", "<b>± " + ed(nl(s.total)) + " kW</b>"), row("Buitenunits", ed(d.buitenunits)), row("Wensen", ed(d.wensen)),
        ]) +
        block("Advies (intern, niet voor klant)", [
          row("Advies systeem", "<b>" + ed(s.systeem) + "</b>"), row("Multisplit-index", ed(s.multiIndex)),
          row("Merk-kader", ed(s.merken.join(" / "))), row("Prijsband", "<b>" + ed(s.band) + "</b> (incl. plaatsing)"),
        ]) +
        block("Herkomst", [
          row("Bronpagina", ed(d.bron_pagina)), row("Landingspagina", ed(d.landingspagina)), row("Gemeentepagina", ed(s.gemeentePagina)),
          row("Apparaat / duur", ed(d.apparaat) + " · " + (s.dur ? Math.round(s.dur / 60) + " min " + (s.dur % 60) + " s" : "-")),
        ]);
      vals = {
        name: `Aircocheck - ${naam || "onbekend"} - ${d.gemeente || ""}`.replace(/ - $/, ""),
        type: "opportunity", contact_name: naam, phone: d.gsm || "", email_from: d.email || "",
        street: d.straat || "", zip: d.postcode || "", city: d.gemeente || "",
        description, priority: s.priority, expected_revenue: bandMid(s.band),
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
        description: `<p style="font-size:15px;margin:0 0 6px"><b>AANVRAAG via smartcooling.be</b></p>` +
          block("Klant", [row("Naam", ed(naam)), row("Adres", ed([straat, d.postcode, d.gemeente].filter(Boolean).join(", "))), row("Telefoon", ed(d.telefoon)), row("E-mail", ed(d.email)), row("Gewenst belmoment", "<b>" + ed(d.belmoment) + "</b>")]) +
          block("Aanvraag", [row("Type", "<b>" + ed(d.systeem) + "</b>"), row("Aantal airco('s)", ed(d.aantal)), row("Type ruimte", ed(ruimte)), row("Gewenste plaatsing", ed(d.plaatsingsdatum)), row("Bericht", ed(d.bericht).replace(/\n/g, "<br>"))]) +
          block("Herkomst", [row("Bronpagina", ed(d.bron_pagina))]),
        x_studio_is_monoblock: isMono, team_id: isMono ? TEAM_MONOBLOCK : TEAM_SALES,
        stage_id: STAGE_NIEUW, source_id: WEBSITE_SOURCE_ID,
      };
    }


    // Contact koppelen: bestaand contact op e-mail zoeken, anders aanmaken
    try {
      if (vals.email_from || vals.contact_name) {
        let pid = null;
        if (vals.email_from) {
          const found = await rpc("object", "execute_kw", [DB, uid, KEY, "res.partner", "search", [[["email", "=ilike", vals.email_from]]], { limit: 1 }]);
          if (found && found.length) pid = found[0];
        }
        if (!pid) pid = await rpc("object", "execute_kw", [DB, uid, KEY, "res.partner", "create", [{ name: vals.contact_name || vals.email_from, email: vals.email_from || false, phone: vals.phone || false, street: vals.street || false, zip: vals.zip || false, city: vals.city || false }]]);
        if (pid) vals.partner_id = pid;
      }
    } catch (e) { console.warn("partner link failed (lead wordt toch aangemaakt):", e.message); }

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
    if (mono && process.env.ODOO_AUTO_QUOTE !== "0") {
      try { const so = await createQuotation(rpc, DB, uid, KEY, vals.partner_id, leadId, mono, naam); console.log("Odoo quotation created:", so); }
      catch (e) { console.warn("quotation not created (lead is OK):", e.message); }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, leadId }) };
  } catch (e) {
    console.error("lead-to-odoo error:", e);
    return { statusCode: 200, body: "error logged" };
  }
};

// exported for local testing
exports._score = score;
