// netlify/functions/submission-created.js  (v10 — lead-mail via Brevo + Odoo lead/offerte)
// v10: stuurt na elke aanvraag een nette lead-mail naar info@smartcooling.be via Brevo (BREVO_API_KEY),
//      ook als Odoo faalt (dan staat "NIET in Odoo gezet" in de mail). Vervangt de ruwe Netlify-formnotificatie.
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
  // verwarming: hoofdverwarming -> toestellen met sterke verwarmingscapaciteit, bijverwarmen -> instapreeksen
  const verw = d.verwarming || "";
  if (/hoofd/i.test(verw)) merken.unshift("HOOFDVERWARMING: Daikin Perfera / Mitsubishi Electric MSZ-AY");
  else if (/bij/i.test(verw)) merken.unshift("BIJVERWARMEN: Mitsubishi Heavy ZR / Daikin Sensira / LG Standard Plus");
  // multisplit: enkel binnenunits die op een multi passen (DUALCOOL WZ is enkel single split)
  if (/^Multisplit/.test(systeem)) {
    for (let i = 0; i < merken.length; i++) merken[i] = merken[i].replace("LG DUALCOOL WZ", "LG Standard Plus");
    if (total > 8.5 || kws.some((k) => k > 5.5)) systeem += " – LET OP: groot vermogen op 1 buitenunit (bv. Nuova 4P-CINF-MS100 of LG MU5R36, ± 10,5 kW); 2 single splits overwegen";
  }
  let tier = 1.0;
  if (has("Hoogste kwaliteit") || has("Laag verbruik") || has("Design")) tier = 1.35;
  else if (has("Stil") || has("Zuivere lucht") || has("AI-sturing")) tier = 1.15;
  if (has("Scherpe prijs") && tier > 1.0) tier -= 0.1;
  if (/hoofd/i.test(d.verwarming || "")) tier += 0.1;

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

// ---------- Lead-mail naar Smart Cooling via Brevo (v10) ----------
// Env: BREVO_API_KEY (verplicht voor de mail), LEAD_MAIL_TO (default info@smartcooling.be),
//      LEAD_MAIL_FROM (default info@smartcooling.be). Zonder BREVO_API_KEY wordt de mail overgeslagen.
const SITE = "https://smartcooling.be";
const MAIL_TO = () => process.env.LEAD_MAIL_TO || "info@smartcooling.be";
const MAIL_FROM = () => process.env.LEAD_MAIL_FROM || "info@smartcooling.be";
const telHref = (t) => "tel:" + String(t || "").replace(/[^\d+]/g, "");
const mrow = (k, v) => `<tr><td style="padding:7px 14px 7px 0;color:#5B6F80;font-size:14px;white-space:nowrap;vertical-align:top;width:34%">${k}</td><td style="padding:7px 0;font-size:15px;color:#0A1622;vertical-align:top">${v}</td></tr>`;
// alleen ingevulde velden tonen
const mrows = (pairs) => pairs.filter(([, v]) => v != null && String(v).trim() !== "" && String(v) !== "-").map(([k, v, raw]) => mrow(k, raw ? v : esc(v))).join("");
const mblock = (title, rowsHtml, accent) => rowsHtml ? `<tr><td style="padding:18px 28px 6px"><div style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${accent || "#1B6FB3"};font-weight:bold;border-bottom:2px solid ${accent || "#1B6FB3"};padding-bottom:4px;margin-bottom:6px">${title}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif">${rowsHtml}</table></td></tr>` : "";

// Bel / WhatsApp / Mail-knoppen (WhatsApp met vooraf ingevuld bericht)
const waNumber = (t) => { let n = String(t || "").replace(/[^\d+]/g, ""); if (n.startsWith("00")) n = n.slice(2); else if (n.startsWith("+")) n = n.slice(1); else if (n.startsWith("0")) n = "32" + n.slice(1); return n; };
function actionsHtml(d, naam) {
  const tel = d.gsm || d.telefoon; if (!tel && !d.email) return "";
  const btn = (bg, href, txt) => `<td style="padding:0 8px 0 0"><a href="${href}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:11px 18px;border-radius:8px">${txt}</a></td>`;
  const voornaam = d.voornaam || (naam || "").split(" ")[0] || "";
  const waText = `Dag ${voornaam}, bedankt voor uw aanvraag via smartcooling.be. Wanneer past het u om kort te bellen voor een gratis plaatsbezoek? Mvg, Smart Cooling`;
  return `<tr><td style="padding:16px 28px 2px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
    (tel ? btn("#1B6FB3", telHref(tel), "&#9742; Bel") + btn("#25D366", "https://wa.me/" + waNumber(tel) + "?text=" + encodeURIComponent(waText), "WhatsApp") : "") +
    (d.email ? btn("#5B6F80", "mailto:" + esc(d.email), "&#9993; Mail") : "") + `</tr></table></td></tr>`;
}
// Voorgestelde volgende stap (intern)
function nextStep(ctx) {
  const { d, mono, s, odoo } = ctx;
  const wanneer = d.dagdeel && d.dagdeel !== "Maakt niet uit" ? ` (klant is best bereikbaar: ${d.dagdeel.toLowerCase()})` : d.belmoment ? ` (gewenst belmoment: ${d.belmoment.toLowerCase()})` : "";
  if (mono) return odoo && odoo.soId ? `offerte S${odoo.soId} staat klaar in Odoo – nakijken en versturen, dan bellen voor het plaatsbezoek${wanneer}.` : `richtprijs is al getoond – bel voor het plaatsbezoek en bevestig de offerte${wanneer}.`;
  if (s && s.temp === "HEET") return `warme lead – vandaag nog bellen${wanneer}.`;
  if (s && s.temp === "WARM") return `binnen 24 u bellen${wanneer}.`;
  return `bellen of mailen binnen 1–2 werkdagen${wanneer}.`;
}

function leadMailHtml(ctx) {
  const { d, form, naam, mono, s, odoo } = ctx;
  const typeLabel = mono ? "Aircocheck – monoblock" : form === "aircocheck" ? "Aircocheck – airco met buitenunit" : "Offerteformulier";
  const adres = [d.straat ? [d.straat, d.huisnr].filter(Boolean).join(" ") : "", [d.postcode, d.gemeente].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const klant = mrows([
    ["Naam", "<b>" + esc(naam || "-") + "</b>", true],
    ["GSM", d.gsm || d.telefoon ? `<a href="${telHref(d.gsm || d.telefoon)}" style="color:#1B6FB3;text-decoration:none"><b>${esc(d.gsm || d.telefoon)}</b></a>` : "", true],
    ["E-mail", d.email ? `<a href="mailto:${esc(d.email)}" style="color:#1B6FB3;text-decoration:none">${esc(d.email)}</a>` : "", true],
    ["Adres", adres ? esc(adres) + `<br><span style="font-size:13px"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(adres)}" style="color:#1B6FB3">Street View / kaart</a> &nbsp;·&nbsp; <a href="${esc((ctx.afstand && ctx.afstand.maps) || ("https://www.google.com/maps/dir/?api=1&origin=" + encodeURIComponent(HQ.label) + "&destination=" + encodeURIComponent(adres)))}" style="color:#1B6FB3">Route vanaf Heusden-Zolder</a></span>` : "", true],
    ["Afstand", ctx.afstand ? (ctx.afstand.km != null
        ? `<b>± ${Math.round(ctx.afstand.km)} km</b> rijden · ± ${Math.round(ctx.afstand.min)} min`
        : `± ${Math.round(ctx.afstand.vogel)} km (vogelvlucht)`) + ((ctx.afstand.km || ctx.afstand.vogel) > 40 ? ` &nbsp;<span style="background:#FFF4E8;color:#C2691E;border-radius:10px;padding:2px 8px;font-size:12px;font-weight:bold">ver &gt; 40 km</span>` : "") : "", true],
    ["Best bereikbaar", d.dagdeel || d.belmoment],
  ]);
  let aanvraag = "", intern = "", monoHtml = "";
  if (mono) {
    const units = (mono.units || []).map((u) => `Monoblock ${u.nr}: ${esc(u.model)} (${esc(u.m2)}, ${esc(u.kw)}) – ${u.actief ? "<b>" + eur(u.prijs) + "</b>" : "<b style=\"color:#B42318\">niet mogelijk: " + esc(u.reden) + "</b>"}`).join("<br>");
    const lines = (mono.lines || []).map((l) => `${esc(l.t)}: <b>${l.p == null ? esc(l.txt || "—") : eur(l.p)}</b>`).join("<br>");
    monoHtml = mrows([
      ["Toestellen", units, true],
      ["Offerteregels", lines, true],
      ["Richtprijs getoond", `<span style="font-size:20px;color:#C2691E;font-weight:bold">${eur(mono.totaal_excl)}</span> excl. btw`, true],
      ["Extra's", d.mono_extras],
      ["Controles", esc(d.mono_checks || "").replace(/ \| /g, "<br>"), true],
    ]);
  } else if (form === "aircocheck") {
    const ruimtes = (d.ruimtes || "").split(" | ").filter(Boolean).map(esc).join("<br>");
    const locatie = (d.locatie || "") + (d.locatie === "Bedrijf" ? ` (${[d.bedrijf_type, d.bedrijf_m2 && d.bedrijf_m2 + " m²", d.bedrijf_personen && d.bedrijf_personen + " pers.", d.bedrijf_apparatuur && "apparatuur: " + d.bedrijf_apparatuur].filter(Boolean).join(", ")})` : "");
    aanvraag = mrows([
      ["Systeem", "<b>" + esc(d.systeem || "") + "</b>", true],
      ["Locatie", locatie],
      ["Ruimtes", ruimtes, true],
      ["Totaal vermogen", s ? "<b>± " + nl(s.total) + " kW</b>" : "", true],
      ["Buitenunits", d.buitenunits],
      ["Top 3 wensen", (d.wensen || "").split(", ").filter((w) => w && w !== d.prioriteit).join(", ")],
      ["Weegt het zwaarst", d.prioriteit],
      ["Verwarming", d.verwarming],
    ]);
    if (s) intern = mrows([
      ["Advies systeem", "<b>" + esc(s.systeem) + "</b>", true],
      ["Merk-kader", s.merken.join(" / ")],
      ["Prijsband", "<b>" + esc(s.band) + "</b> incl. plaatsing (ruwe schatting)", true],
      ["Leadtemperatuur", "<b>" + esc(s.temp) + "</b>", true],
    ]);
  } else {
    const ruimte = Array.isArray(d.ruimte) ? d.ruimte.join(", ") : (d.ruimte || "");
    aanvraag = mrows([
      ["Type", "<b>" + esc(d.systeem || "") + "</b>", true],
      ["Aantal airco('s)", d.aantal], ["Type ruimte", ruimte], ["Gewenste plaatsing", d.plaatsingsdatum],
      ["Bericht", esc(d.bericht || "").replace(/\n/g, "<br>"), true],
    ]);
  }
  const herkomst = mrows([
    ["Pagina", d.landingspagina && d.landingspagina !== "/" ? SITE + d.landingspagina : (d.bron_pagina && d.bron_pagina !== "/" ? SITE + d.bron_pagina : "")],
    ["Apparaat", d.apparaat && d.apparaat !== "mobiel" && d.apparaat !== "desktop" ? d.apparaat : ""],
  ]);
  const ok = odoo && odoo.leadId;
  const odooHtml = ok
    ? `<span style="display:inline-block;background:#E6F4EA;color:#1E7B34;border-radius:14px;padding:5px 14px;font-weight:bold">&#10004; Lead aangemaakt in Odoo</span> &nbsp;<a href="${esc(odoo.url)}" style="color:#1B6FB3;font-weight:bold">Open lead #${odoo.leadId}</a>${odoo.soId ? ` &nbsp;·&nbsp; offerte S${odoo.soId} aangemaakt` : ""}`
    : `<span style="display:inline-block;background:#FDECEC;color:#B42318;border-radius:14px;padding:5px 14px;font-weight:bold">&#10008; NIET in Odoo gezet</span> &nbsp;<span style="color:#B42318">Lead handmatig invoeren.</span><br><span style="font-size:12px;color:#5B6F80">${esc((odoo && odoo.error) || "onbekende fout")}</span>`;
  const temp = s ? s.temp : mono ? "MONOBLOCK" : "";
  const tempKleur = /HEET/.test(temp) ? "#C0392B" : /WARM/.test(temp) ? "#D68910" : /MONO/.test(temp) ? "#C2691E" : "#1B6FB3";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#EEF3F7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF3F7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#fff;border-radius:14px;overflow:hidden;font-family:Arial,sans-serif">
<tr><td style="padding:24px 28px 10px;border-bottom:1px solid #E3EAF0"><img src="${SITE}/assets/logo.png" width="170" alt="Smart Cooling" style="display:block;width:170px;height:auto;border:0"></td></tr>
<tr><td style="padding:22px 28px 4px"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5B6F80">Nieuwe aanvraag via smartcooling.be</div>
<div style="font-size:24px;font-weight:bold;color:#0A1622;margin:6px 0 10px">${esc(naam || "Onbekend")}${d.gemeente ? ` <span style="font-weight:normal;color:#5B6F80">· ${esc(d.gemeente)}</span>` : ""}</div>
<span style="display:inline-block;background:#1B6FB3;color:#fff;border-radius:14px;padding:5px 14px;font-size:13px;font-weight:bold">${esc(typeLabel)}</span>${temp ? ` <span style="display:inline-block;background:${tempKleur};color:#fff;border-radius:14px;padding:5px 14px;font-size:13px;font-weight:bold">${esc(temp)}</span>` : ""}</td></tr>
${actionsHtml(d, naam)}
${ctx.eerder ? `<tr><td style="padding:12px 28px 0"><div style="background:#FFF4E8;border-left:4px solid #C2691E;border-radius:6px;padding:10px 14px;font-size:14px;color:#0A1622">&#9888; <b>Bekende klant:</b> vroeg al eerder aan op ${esc(ctx.eerder.datum)} &mdash; ${esc(ctx.eerder.naam)}${ctx.eerder.url ? ` (<a href="${esc(ctx.eerder.url)}" style="color:#1B6FB3">lead #${ctx.eerder.id}</a>)` : ""}</div></td></tr>` : ""}
${nextStep(ctx) ? `<tr><td style="padding:12px 28px 0"><div style="background:#E8F1FA;border-left:4px solid #1B6FB3;border-radius:6px;padding:10px 14px;font-size:14px;color:#0A1622">&#10148; <b>Volgende stap:</b> ${nextStep(ctx)}</div></td></tr>` : ""}
${mblock("Klant", klant)}
${mblock("Aanvraag", aanvraag)}
${mblock("Monoblock – richtprijs zoals getoond aan de klant", monoHtml, "#C2691E")}
${mblock("Intern advies (niet voor de klant)", intern, "#5B6F80")}
${mblock("Herkomst", herkomst, "#5B6F80")}
<tr><td style="padding:20px 28px 26px"><div style="background:#F6F9FC;border-radius:10px;padding:14px 16px;font-size:14px">${odooHtml}</div></td></tr>
<tr><td style="padding:14px 28px;background:#0A1622;color:#9FB3C4;font-size:12px">Smart Cooling · automatische lead-melding · beantwoord deze mail om de klant rechtstreeks te mailen</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendLeadMail(ctx) {
  const key = process.env.BREVO_API_KEY;
  if (!key) { console.warn("BREVO_API_KEY ontbreekt – lead-mail overgeslagen"); return false; }
  const { d, naam, mono, form } = ctx;
  const type = mono ? "Monoblock" : form === "aircocheck" ? "Aircocheck" : "Offerte";
  const ok = ctx.odoo && ctx.odoo.leadId;
  const prefix = !ok ? "⚠ NIET IN ODOO" : mono ? "🟢 Monoblock" : ctx.s && ctx.s.temp === "HEET" ? "🔥 HEET · " + type : ctx.s && ctx.s.temp === "WARM" ? "🟠 WARM · " + type : "🔵 " + type;
  const extra = mono ? eur(mono.totaal_excl) : ctx.s && ctx.s.rooms.length ? ctx.s.rooms.length + (ctx.s.rooms.length === 1 ? " ruimte" : " ruimtes") : "";
  const subject = [prefix, d.naam || naam || "onbekend", d.gemeente, extra, ctx.afstand && ctx.afstand.km != null ? Math.round(ctx.afstand.km) + " km" : ""].filter(Boolean).join(" · ");
  const body = {
    sender: { name: "Smart Cooling website", email: MAIL_FROM() },
    to: [{ email: MAIL_TO() }],
    subject, htmlContent: leadMailHtml(ctx),
    tags: ["lead", form],
  };
  if (d.email && /@/.test(d.email)) body.replyTo = { email: d.email, name: naam || d.email };
  const res = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": key, "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) throw new Error("Brevo " + res.status + ": " + txt.slice(0, 300));
  console.log("lead-mail sent:", txt.slice(0, 120));
  return true;
}
// Rijafstand vanaf Smart Cooling (Lochtemanweg 96, Heusden-Zolder) – OpenStreetMap/OSRM, gratis, geen key.
const HQ = { lat: 51.0314063, lon: 5.2314989, label: "Lochtemanweg 96, 3550 Heusden-Zolder" };
async function afstand(d) {
  const adres = [d.straat ? [d.straat, d.huisnr].filter(Boolean).join(" ") : "", d.postcode, d.gemeente].filter(Boolean).join(", ");
  if (!d.gemeente && !d.postcode) return null;
  const ua = { "User-Agent": "smartcooling.be lead-mail (info@smartcooling.be)", "Accept": "application/json" };
  const geo = async (q) => { const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=be&q=" + encodeURIComponent(q), { headers: ua }); const j = await r.json(); return j && j[0] ? { lat: +j[0].lat, lon: +j[0].lon } : null; };
  let p = await geo(adres + ", België");
  if (!p && d.gemeente) p = await geo([d.postcode, d.gemeente].filter(Boolean).join(" ") + ", België");
  if (!p) return null;
  const toRad = (x) => x * Math.PI / 180, R = 6371;
  const dLat = toRad(p.lat - HQ.lat), dLon = toRad(p.lon - HQ.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(HQ.lat)) * Math.cos(toRad(p.lat)) * Math.sin(dLon / 2) ** 2;
  const vogel = 2 * R * Math.asin(Math.sqrt(a));
  let km = null, min = null;
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${HQ.lon},${HQ.lat};${p.lon},${p.lat}?overview=false`, { headers: ua });
    const j = await r.json();
    if (j && j.code === "Ok" && j.routes && j.routes[0]) { km = j.routes[0].distance / 1000; min = j.routes[0].duration / 60; }
  } catch (e) {}
  const maps = "https://www.google.com/maps/dir/?api=1&origin=" + encodeURIComponent(HQ.label) + "&destination=" + encodeURIComponent(adres || (p.lat + "," + p.lon));
  return { km, min, vogel, maps };
}
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " duurde langer dan " + ms / 1000 + " s")), ms))]);

// ---- HTML helpers voor een leesbare notitie in Odoo ----
const ed = (v) => String(v == null || v === "" ? "-" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const row = (k, v) => `<tr><td style="padding:3px 14px 3px 0;color:#5b6b7a;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:3px 0;vertical-align:top">${v}</td></tr>`;
const block = (title, rows) => `<h4 style="margin:14px 0 4px;color:#0A1622">${title}</h4><table style="border-collapse:collapse;font-size:14px">${rows.join("")}</table>`;
const bandMid = (band) => { const n = String(band || "").replace(/\./g, "").match(/\d+/g); if (!n || !n.length) return 0; const a = n.map(Number); return Math.round((Math.min(...a) + Math.max(...a)) / 2); };

// Odoo: contact koppelen, lead aanmaken, (monoblock) offerte aanmaken. Gooit bij fout.
async function pushToOdoo(vals, extra, mono, naam) {
  const URL = process.env.ODOO_URL, DB = process.env.ODOO_DB, LOGIN = process.env.ODOO_LOGIN, KEY = process.env.ODOO_API_KEY;
  if (!URL || !DB || !LOGIN || !KEY) throw new Error("Odoo-instellingen (env vars) ontbreken in Netlify");
  const rpc = async (service, method, args) => {
    const res = await fetch(`${URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }) });
    const j = await res.json();
    if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message || JSON.stringify(j.error));
    return j.result;
  };
  const uid = await rpc("common", "authenticate", [DB, LOGIN, KEY, {}]);
  if (!uid) throw new Error("Odoo-aanmelding mislukt (login/API key nakijken)");

  // Bekende klant? (eerdere lead op e-mail of telefoon)
  let eerder = null;
  try {
    const dom = ["|", ["email_from", "=ilike", vals.email_from || "__none__"], ["phone", "ilike", (vals.phone || "__none__").replace(/\s|\/|\./g, "").slice(-8)]];
    const prev = await rpc("object", "execute_kw", [DB, uid, KEY, "crm.lead", "search_read", [dom], { fields: ["id", "name", "create_date"], limit: 1, order: "create_date desc" }]);
    if (prev && prev.length) {
      const p = prev[0]; const dt = new Date(p.create_date.replace(" ", "T") + "Z");
      eerder = { id: p.id, naam: p.name, datum: dt.toLocaleDateString("nl-BE", { timeZone: "Europe/Brussels" }), url: `${URL.replace(/\/$/, "")}/odoo/crm/${p.id}` };
    }
  } catch (e) { console.warn("eerdere lead check mislukt:", e.message); }

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
  console.log("Odoo lead created:", leadId);
  let soId = null;
  if (mono && process.env.ODOO_AUTO_QUOTE !== "0") {
    try { soId = await createQuotation(rpc, DB, uid, KEY, vals.partner_id, leadId, mono, naam); console.log("Odoo quotation created:", soId); }
    catch (e) { console.warn("quotation not created (lead is OK):", e.message); }
  }
  return { leadId, soId, eerder, url: `${URL.replace(/\/$/, "")}/odoo/crm/${leadId}` };
}

exports.handler = async (event) => {
  let ctx = null;
  try {
    const payload = JSON.parse(event.body || "{}").payload || {};
    const form = payload.form_name || "offerte";
    if (!["offerte", "aircocheck"].includes(form)) return { statusCode: 200, body: "ignored (other form)" };
    const d = payload.data || {};

    const naam = [d.voornaam, d.naam].filter(Boolean).join(" ").trim();
    const isMono = /monoblock/i.test(d.systeem || "");
    let vals, extra = {};

    const mono = form === "aircocheck" ? parseMono(d) : null;
    ctx = { d, form, naam, mono, s: null, odoo: null };
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
      const s = score(d); ctx.s = s;
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
          row("Totaal vermogen", "<b>± " + ed(nl(s.total)) + " kW</b>"), row("Buitenunits", ed(d.buitenunits)), row("Wensen", ed(d.wensen)), row("Verwarming", ed(d.verwarming)),
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

    // 1) Odoo (max. 7 s, anders gaat de mail toch uit met status "niet in Odoo") + rijafstand (parallel, max. 4 s)
    const [odooRes, afst] = await Promise.all([
      withTimeout(pushToOdoo(vals, extra, mono, naam), 7000, "Odoo").catch((e) => { console.error("lead-to-odoo error:", e.message); return { error: e.message }; }),
      withTimeout(afstand(d), 4000, "Afstand").catch((e) => { console.warn("afstand niet berekend:", e.message); return null; }),
    ]);
    ctx.odoo = odooRes; ctx.afstand = afst; ctx.eerder = odooRes && odooRes.eerder;
  } catch (e) {
    console.error("submission-created error:", e);
    if (ctx) ctx.odoo = { error: "fout in de functie: " + e.message };
  }

  // 2) Lead-mail naar Smart Cooling – altijd, ook als Odoo faalde
  if (ctx) {
    try { await sendLeadMail(ctx); }
    catch (e) { console.error("lead-mail failed:", e.message); }
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, odoo: ctx && ctx.odoo }) };
};

// exported for local testing
exports._score = score;
