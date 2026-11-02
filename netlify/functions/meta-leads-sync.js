// netlify/functions/meta-leads-sync.js  (v1, 2/11/2026)
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
const pick = (o, ...keys) => { for (const k of keys) for (const key of Object.keys(o)) if (key.toLowerCase().includes(k)) return o[key]; return ""; };

function toPayload(lead, formName) {
  const f = fields(lead);
  const voornaam = pick(f, "first_name", "voornaam") || (pick(f, "full_name", "naam").split(" ")[0] || "");
  const achternaam = pick(f, "last_name", "achternaam") || pick(f, "full_name").split(" ").slice(1).join(" ");
  const extra = Object.entries(f)
    .filter(([k]) => !/first_name|last_name|full_name|email|phone|post|zip|city|stad|gemeente|street|straat/i.test(k))
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n");
  const titel = (formName.split("|").map((s) => s.trim()).filter(Boolean)[2] || "Meta-advertentie");
  return {
    form_name: "offerte",
    data: {
      voornaam, naam: achternaam,
      email: pick(f, "email"), telefoon: pick(f, "phone", "telefoon", "gsm"),
      straat: pick(f, "street", "straat"), postcode: pick(f, "zip", "post"), gemeente: pick(f, "city", "gemeente", "stad"),
      systeem: titel, bericht: extra + `\n\nFormulier: ${formName}\nAdvertentie: ${lead.ad_name || "-"}\nCampagne: ${lead.campaign_name || "-"}\nMeta lead-ID: ${lead.id}`,
      bron_pagina: `Meta-advertentie – ${titel} – ${lead.ad_name || ""}`.trim(),
      lead_titel: `Meta ${titel} - ${[voornaam, achternaam].filter(Boolean).join(" ") || "onbekend"}`,
    },
  };
}

exports.handler = async () => {
  const token = process.env.META_ACCESS_TOKEN, pageId = process.env.META_PAGE_ID;
  const formIds = (process.env.META_FORM_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!token || !pageId || !formIds.length) { console.log("meta-leads-sync: env vars ontbreken, niets gedaan"); return { statusCode: 200 }; }
  let pageToken = token;
  try { pageToken = (await graph(`${pageId}?fields=access_token`, token)).access_token || token; }
  catch (e) { console.warn("page token niet opgehaald, systeemtoken gebruikt:", e.message); }
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_H * 3600;
  let nieuw = 0, overgeslagen = 0;
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
        try {
          if (await odooHasLead(call, lead.id)) { overgeslagen++; continue; }
          const payload = toPayload(lead, form.name || formId);
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
  console.log(`meta-leads-sync klaar: ${nieuw} nieuw, ${overgeslagen} al in Odoo`);
  return { statusCode: 200, body: JSON.stringify({ nieuw, overgeslagen }) };
};
