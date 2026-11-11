// netlify/functions/meta-leads-sync.js  (v2, 3/11/2026: NL-veldnamen, naam-fix + herstel bestaande leads)
// Scheduled function (elke 10 min): haalt nieuwe leads op uit Meta-leadformulieren en verwerkt ze
// precies zoals een website-aanvraag: lead in Odoo + lead-mail via Brevo (lib/lead.js).
// Enkel de formulieren in META_FORM_IDS worden gesynchroniseerd (andere Meta-leads blijven zoals ze zijn).
//
// Netlify environment variables (in de Netlify-UI, NOOIT in dit bestand):
//   META_ACCESS_TOKEN  systeemgebruiker-token (Odoo Integratie, Smart Cooling), recht: leads_retrieval
//   META_PAGE_ID       942119625645272 (pagina Smart Cooling)
//   META_FORM_IDS      komma-gescheiden lijst van leadformulier-ID's, bv. "1234567890"
//   + de bestaande ODOO_* en BREVO_* variabelen.
// Dubbels: elke lead krijgt "Meta lead-ID: <id>" in de beschrijving; staat die al in Odoo, dan wordt hij overgeslagen.

const { processLead } = require("./lib/lead.js");
const GRAPH = "https://graph.facebook.com/v21.0";
const LOOKBACK_H = 48; // elke run kijkt 48 u terug; dubbels worden via Odoo herkend

async function graph(path, token) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`);
  const j = await r.json();
  if (j.error) throw new Error("Meta: " + (j.error.message || JSON.stringify(j.error)));
  return j;
}

async function odoo() {
  const URL = process.env.ODOO_URL, DB = process.env.ODOO_DB, LOGIN = process.env.ODOO_LOGIN, KEY = process.env.ODOO_API_KEY;
  const rpc = async (service, method, args) => {
    const res = await fetch(`${URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }) });
    const j = await res.json();
    if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message);
    return j.result;
  };
  const uid = await rpc("common", "authenticate", [DB, LOGIN, KEY, {}]);
  return (model, method, args, kw) => rpc("object", "execute_kw", [DB, uid, KEY, model, method, args, kw || {}]);
}
async function odooHasLead(call, metaId) {
  const n = await call("crm.lead", "search_count", [[["description", "ilike", "Meta lead-ID: " + metaId], ["active", "in", [true, false]]]]);
  return n > 0;
}

// Meta field_data [{name, values:[...]}] -> plat object
function fields(lead) {
  const o = {};
  for (const f of lead.field_data || []) o[f.name] = (f.values || []).join(", ");
  return o;
}
// Veldnamen kunnen Engels (full_name, email, ...) of Nederlands (volledige_naam, e-mailadres, ...) zijn.
// Eerst exacte namen, dan "bevat" met uitsluitingen (bv. "straatnaam" bevat "naam" maar is geen naam).
const norm = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
function pick(o, exact, contains = [], exclude = []) {
  const keys = Object.keys(o);
  for (const e of exact) { const k = keys.find((x) => norm(x) === norm(e)); if (k && o[k]) return o[k]; }
  for (const c of contains) {
    const k = keys.find((x) => norm(x).includes(norm(c)) && !exclude.some((ex) => norm(x).includes(norm(ex))));
    if (k && o[k]) return o[k];
  }
  return "";
}
const FIELDS = {
  first: [["first_name", "voornaam"], []],
  last: [["last_name", "achternaam", "familienaam"], []],
  full: [["full_name", "volledige_naam", "naam", "name"], ["volledigenaam", "fullname"], ["straat", "street", "bedrijf", "company"]],
  email: [["email", "e-mailadres", "emailadres"], ["mail"]],
  phone: [["phone_number", "phone", "telefoonnummer", "telefoon", "gsm"], ["phone", "telefoon", "gsm"]],
  street: [["street_address", "straat_en_nummer", "straatnaam_en_nummer", "adres"], ["street", "straat"], ["mail"]],
  zip: [["post_code", "postcode", "zip_code", "zip"], ["post", "zip"]],
  city: [["city", "plaats", "gemeente", "woonplaats", "stad"], ["city", "plaats", "gemeente", "stad"]],
};
const get = (f, n) => pick(f, ...FIELDS[n]);
const USED = /first_?name|last_?name|full_?name|volledige_?naam|voornaam|achternaam|mail|phone|telefoon|gsm|post|zip|city|plaats|stad|gemeente|street|straat|adres/i;

// Antwoorden uit Meta leesbaar maken: "20_–_30_m²" -> "20–30 m²", "2_ruimtes" -> "2 ruimtes"
const clean = (v) => String(v || "").replace(/_?–_?/g, "–").replace(/_/g, " ").replace(/\s+/g, " ").trim();
const leeg = (v) => !v || /overslaan|^geen$|^n\.?v\.?t\.?$/i.test(v);

// Vragen van het leadformulier herkennen (aantal ruimtes, m² per ruimte, plaatsing, belmoment)
function vragen(f) {
  const o = { aantal: "", ruimtes: [], plaatsing: "", belmoment: "", rest: [] };
  const kamer = {}; // nr -> { type, m2 }
  for (const [k, v] of Object.entries(f)) {
    if (USED.test(k) && !/ruimte|plaats(en|ing)|bellen|belmoment/i.test(k)) continue;
    const key = k.toLowerCase().replace(/_/g, " ");
    const val = clean(v);
    let m;
    if (/hoeveel ruimtes|aantal ruimtes|hoeveel airco/.test(key)) o.aantal = (val.match(/\d+/) || [val])[0];
    else if ((m = key.match(/ruimte\s*(\d)/))) {
      if (leeg(val)) continue;
      const r = (kamer[m[1]] = kamer[m[1]] || {});
      // m²-antwoord (bv. "20–30 m²", "< 20 m²") of ruimtetype (Living, Keuken, Slaapkamer, ...)
      if (/m²|m2|\d/.test(val) || /groot|m²|m2|oppervlakte/.test(key)) r.m2 = val; else r.type = val;
    }
    else if (/bellen|belmoment|bereikbaar/.test(key)) o.belmoment = val;
    else if (/wanneer|plaats(en|ing)/.test(key)) o.plaatsing = val;
    else if (!USED.test(k)) o.rest.push(`${clean(k).replace(/\?$/, "")}: ${val}`);
  }
  const n = Number(o.aantal) || Object.keys(kamer).length;
  o.ruimtes = Object.keys(kamer).sort().filter((nr) => !n || Number(nr) <= n)
    .map((nr) => `${kamer[nr].type ? kamer[nr].type : "Ruimte " + nr}: ${kamer[nr].m2 || "grootte niet opgegeven"}`);
  return o;
}

function toPayload(lead, formName) {
  const f = fields(lead);
  const full = get(f, "full");
  const voornaam = get(f, "first") || (full.split(" ")[0] || "");
  const achternaam = get(f, "last") || full.split(" ").slice(1).join(" ");
  const q = vragen(f);
  const titel = (formName.split("|").map((s) => s.trim()).filter(Boolean)[2] || "Meta-advertentie").replace(/Mitubishi/i, "Mitsubishi");
  const naamVol = [voornaam, achternaam].filter(Boolean).join(" ");
  const bericht = [
    q.rest.join("\n"),
    [`Formulier: ${formName}`, lead.ad_name ? `Advertentie: ${lead.ad_name}` : "", lead.campaign_name ? `Campagne: ${lead.campaign_name}` : "", `Meta lead-ID: ${lead.id}`].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n\n");
  return {
    form_name: "offerte",
    data: {
      voornaam, naam: achternaam,
      email: get(f, "email"), telefoon: get(f, "phone"),
      straat: get(f, "street"), postcode: get(f, "zip"), gemeente: get(f, "city"),
      systeem: titel,
      aantal: q.aantal ? `${q.aantal} ${Number(q.aantal) === 1 ? "ruimte" : "ruimtes"}` : "",
      ruimtes_m2: q.ruimtes.join("\n"),
      plaatsingsdatum: q.plaatsing, belmoment: q.belmoment,
      bericht,
      bron_pagina: `Meta-advertentie – ${titel} – ${lead.ad_name || ""}`.trim().replace(/ –$/, ""),
      lead_titel: `Meta ${titel} - ${naamVol || "onbekend"}${get(f, "city") ? " (" + get(f, "city") + ")" : ""}`,
      naam_vol: naamVol,
    },
  };
}

// Herstel van leads die vóór v2 met een verkeerde naam (bv. straatnaam) in Odoo kwamen.
const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MARKER = "Samenvatting formulier";
function samenvatting(d) {
  const r = (k, v) => v ? `<tr><td style="padding:3px 14px 3px 0;color:#5b6b7a;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:3px 0;vertical-align:top"><b>${esc(v).replace(/\n/g, "<br>")}</b></td></tr>` : "";
  const rows = r("Aantal", d.aantal) + r("Grootte per ruimte", d.ruimtes_m2) + r("Gewenste plaatsing", d.plaatsingsdatum) + r("Gewenst belmoment", d.belmoment);
  return rows ? `<h4 style="margin:0 0 4px;color:#0A1622">${MARKER}</h4><table style="border-collapse:collapse;font-size:14px">${rows}</table><hr>` : "";
}

async function repairLead(call, metaId, p) {
  const ids = await call("crm.lead", "search", [[["description", "ilike", "Meta lead-ID: " + metaId], ["active", "in", [true, false]]]], { limit: 1 });
  if (!ids.length) return false;
  const [cur] = await call("crm.lead", "read", [ids], { fields: ["name", "contact_name", "description"] });
  // v3: oudere leads krijgen bovenaan een leesbare samenvatting (bestaande notities blijven staan)
  const desc = (cur && cur.description) || "";
  if (!desc.includes(MARKER) && !desc.includes("Grootte per ruimte")) {
    const blok = samenvatting(p.data);
    if (blok) { await call("crm.lead", "write", [ids, { description: blok + desc }]); console.log("samenvatting toegevoegd:", ids[0]); }
  }
  if (cur && cur.name === p.data.lead_titel) return false;
  const vals = { name: p.data.lead_titel, contact_name: p.data.naam_vol || false };
  if (p.data.email) vals.email_from = p.data.email;
  if (p.data.telefoon) vals.phone = p.data.telefoon;
  if (p.data.straat) vals.street = p.data.straat;
  if (p.data.postcode) vals.zip = p.data.postcode;
  if (p.data.gemeente) vals.city = p.data.gemeente;
  await call("crm.lead", "write", [ids, vals]);
  console.log("lead hersteld:", ids[0]);
  return true;
}

exports.handler = async () => {
  const token = process.env.META_ACCESS_TOKEN, pageId = process.env.META_PAGE_ID;
  const formIds = (process.env.META_FORM_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!token || !pageId || !formIds.length) { console.log("meta-leads-sync: env vars ontbreken, niets gedaan"); return { statusCode: 200 }; }
  let pageToken = token;
  try { pageToken = (await graph(`${pageId}?fields=access_token`, token)).access_token || token; }
  catch (e) { console.warn("page token niet opgehaald, systeemtoken gebruikt:", e.message); }
  // v3: tot 13/11/2026 eenmalig terugkijken tot de campagnestart (2/11) om oudere leads een samenvatting te geven
  const since = Date.now() < Date.parse("2026-11-13T00:00:00Z")
    ? Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000)
    : Math.floor(Date.now() / 1000) - LOOKBACK_H * 3600;
  let nieuw = 0, overgeslagen = 0, test = 0;
  const call = await odoo();
  for (const formId of formIds) {
    let form = { name: formId };
    try { form = await graph(`${formId}?fields=name`, pageToken); } catch (e) { console.warn("formnaam:", e.message); }
    const filter = encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]));
    let url = `${formId}/leads?fields=id,created_time,field_data,ad_name,campaign_name&limit=100&filtering=${filter}`;
    while (url) {
      const page = url.startsWith("http") ? await (await fetch(url)).json() : await graph(url, pageToken);
      if (page.error) throw new Error("Meta: " + page.error.message);
      for (const lead of page.data || []) {
        // Meta-testleads (Lead Ads Testing Tool: "<test lead: dummy data ...>", test@meta.com) nooit naar Odoo/mail
        if ((lead.field_data || []).some((f) => (f.values || []).some((v) => /<test lead:|^test@meta\.com$/i.test(v)))) { test++; continue; }
        try {
          const payload = toPayload(lead, form.name || formId);
          if (await odooHasLead(call, lead.id)) { await repairLead(call, lead.id, payload).catch((e) => console.warn("herstel mislukt:", e.message)); overgeslagen++; continue; }
          const out = await processLead(payload, { attempts: 1, odooTimeout: 12000 });
          // titel in Odoo: "Meta Mitsubishi MSZ-HR - naam" i.p.v. "Website aanvraag - naam"
          const leadId = out && out.odoo && out.odoo.leadId;
          if (leadId) await call("crm.lead", "write", [[leadId], { name: payload.data.lead_titel }]).catch((e) => console.warn("titel niet aangepast:", e.message));
          nieuw++;
        } catch (e) { console.error("lead " + lead.id + " mislukt:", e.message); }
      }
      url = (page.paging && page.paging.next) || null;
    }
  }
  console.log(`meta-leads-sync klaar: ${nieuw} nieuw, ${overgeslagen} al in Odoo, ${test} Meta-testlead(s) genegeerd`);
  return { statusCode: 200, body: JSON.stringify({ nieuw, overgeslagen }) };
};
