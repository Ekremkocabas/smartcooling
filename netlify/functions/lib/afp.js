// netlify/functions/lib/afp.js  (v1, 27/11/2026 — testweek AircoFlowPro naast Odoo)
// Stuurt een aanvraag (website-formulier of Meta-leadformulier) OOK naar de lead-webhook van AircoFlowPro (AFP).
// Odoo en de lead-mail via Brevo blijven exact zoals ze waren: AFP komt er enkel bij, NA die stappen.
// Een fout bij AFP breekt nooit iets: elke functie hier vangt zelf alles op en geeft een resultaat terug (gooit nooit).
//
// Netlify environment variables (in de Netlify-UI, NOOIT in dit bestand):
//   AFP_LEADS_URL  het webhook-adres uit AFP (Leads › Borden beheren › Leadbronnen › "Webhook-adres kopiëren"),
//                  bv. https://<app>/api/leads/webhook/<token>
//   AFP_LEADS_KEY  de geheime sleutel uit hetzelfde blok ("Sleutel maken"); gaat enkel in de kop X-Sleutel.
// Ontbreekt één van beide, dan doet deze module niets (geen extra verkeer, geen fout).
//
// Dubbels: externe_id = "web:<id van de Netlify-inzending>" of "meta:<Meta lead-ID>". AFP maakt voor een id dat het al kent
// nooit een tweede kaart (antwoord {bestond: true}). Een bestaande klant met een open kaart krijgt ook geen tweede kaart.
// AFP stuurt nooit een mail naar de klant.

const crypto = require("crypto");

const ingesteld = () => Boolean((process.env.AFP_LEADS_URL || "").trim() && (process.env.AFP_LEADS_KEY || "").trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_ITEMS = 40, MAX_WAARDE = 500, MAX_LABEL = 80; // grenzen van de AFP-webhook (veld "aanvraag")
const TEST_LEAD = /<test lead:|^test@meta\.com$/i;

const txt = (v) => (v == null ? "" : String(v)).replace(/\r\n?/g, "\n").trim();
const cleanMeta = (v) => String(v || "").replace(/_?–_?/g, "–").replace(/_/g, " ").replace(/\s+/g, " ").trim();
const mens = (k) => { const s = String(k).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\?$/, ""); return s.charAt(0).toUpperCase() + s.slice(1); };

// Lange waarden worden gesplitst ("… (vervolg)") zodat niets verloren gaat; max. 40 regels (de rest samen in "Overige velden").
function regels(paren) {
  const uit = [];
  for (const [label, waarde] of paren) {
    const w = txt(Array.isArray(waarde) ? waarde.join(", ") : waarde);
    if (!w || w === "-") continue;
    const l = String(label).slice(0, MAX_LABEL);
    for (let i = 0; i < w.length; i += MAX_WAARDE) uit.push({ label: i ? (l.slice(0, MAX_LABEL - 10) + " (vervolg)") : l, waarde: w.slice(i, i + MAX_WAARDE) });
  }
  if (uit.length <= MAX_ITEMS) return uit;
  const rest = uit.slice(MAX_ITEMS - 1).map((x) => `${x.label}: ${x.waarde}`).join(" | ");
  return [...uit.slice(0, MAX_ITEMS - 1), { label: "Overige velden", waarde: rest.slice(0, MAX_WAARDE) }];
}

// ---------- Notities: dezelfde beschrijving als in Odoo, als platte tekst ----------
// De notitie wordt gemaakt UIT de Odoo-beschrijving zelf (de html die lib/lead.js naar Odoo stuurt): zelfde blokken
// (Klant / Aanvraag / Herkomst …), zelfde rijen, zelfde waarden. Er kan dus niets minder in staan dan in Odoo.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", ndash: "–", mdash: "—", middot: "·", plusmn: "±", sup2: "²", eacute: "é", euml: "ë", iuml: "ï" };
function htmlNaarTekst(html) {
  return String(html || "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n  ")
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, t) => "\n\n— " + t.replace(/<[^>]+>/g, "").trim() + " —\n")
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ": ")
    .replace(/<\/(tr|p|table|div|li|ul|ol)>|<hr[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m))
    .replace(/\u00a0/g, " ").split("\n").map((r) => (/^ {2,}$/.test(r) ? "  " : r.replace(/[ \t]+$/g, "")).replace(/^[ \t]+(?! )/, (x) => (x.length >= 2 ? "  " : ""))).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}
const ontvangen = (iso) => { const d = iso ? new Date(iso) : new Date(); const x = isNaN(d) ? new Date() : d; return x.toLocaleString("nl-BE", { timeZone: "Europe/Brussels", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", ""); };
// titel = de titel van de lead in Odoo; html = de Odoo-beschrijving; zonder html (Odoo niet leesbaar) valt het terug op de regels van Aanvraag.
function notitie(titel, html, wanneer, regelsTerugval) {
  const tekst = html ? htmlNaarTekst(html) : (regelsTerugval || []).filter((x) => x.label !== "Titel").map((x) => `${x.label}: ${String(x.waarde).replace(/\n/g, "\n  ")}`).join("\n");
  return [titel, "Ontvangen: " + ontvangen(wanneer), "", tekst].join("\n").slice(0, 20000);
}

// ---------- website (Netlify-formulieren offerte / aircocheck / kras) ----------
const LABELS = {
  voornaam: "Voornaam", naam: "Naam", telefoon: "Telefoon", gsm: "GSM", email: "E-mail", straat: "Straat", huisnr: "Huisnummer",
  postcode: "Postcode", gemeente: "Gemeente", systeem: "Toestel / type", aantal: "Aantal airco('s)", ruimte: "Type ruimte",
  ruimtes: "Ruimtes", ruimtes_m2: "Grootte per ruimte", plaatsingsdatum: "Gewenste plaatsing", belmoment: "Gewenst belmoment",
  dagdeel: "Best bereikbaar", bericht: "Bericht", locatie: "Locatie", bedrijf_type: "Type bedrijf", bedrijf_m2: "Oppervlakte bedrijf (m²)",
  bedrijf_personen: "Personen", bedrijf_apparatuur: "Apparatuur", buitenunits: "Buitenunits", wensen: "Wensen", verwarming: "Verwarming",
  merk: "Voorkeur merk", interesse: "Wat zoekt de klant", wanneer: "Wanneer", mono_checks: "Controles monoblock", mono_extras: "Extra's monoblock",
  korting: "Kraskaart: gewonnen (€)", code: "Kraskaart: code", nummer: "Kraskaart: deelnemer nr.", geldig_tot: "Kraskaart: geldig tot",
  stap: "Kraskaart: stap", bron_pagina: "Bronpagina", landingspagina: "Landingspagina", apparaat: "Apparaat", duur_sec: "Duur op formulier (s)",
  utm: "UTM", referrer: "Doorverwezen door", lead_titel: "Titel (Meta)", naam_vol: "Volledige naam",
};
// nooit naar AFP: technische velden, spamval, geheime kraskaart-token, IP/browser van de bezoeker
const OVERSLAAN = new Set(["bot-field", "form-name", "kras_token", "ip", "user_agent", "g-recaptcha-response", "ruimtes_json", "mono_json"]);
const KLANT = ["voornaam", "naam", "telefoon", "gsm", "email", "straat", "huisnr", "postcode", "gemeente", "dagdeel", "belmoment"];
const HERKOMST = ["bron_pagina", "landingspagina", "apparaat", "duur_sec", "utm", "referrer"];

const isMeta = (d) => /^Meta-advertentie/i.test((d && d.bron_pagina) || "");
const volNaam = (d) => [d.voornaam, d.naam].filter(Boolean).join(" ").trim();
function monoInfo(d) { try { const m = JSON.parse(d.mono_json || ""); return m && Array.isArray(m.units) ? m : null; } catch (e) { return null; } }

// Zelfde titel als de lead in Odoo krijgt (lib/lead.js)
function titelWebsite(form, d) {
  const naam = volNaam(d) || "onbekend";
  if (form === "aircocheck") return (monoInfo(d) ? `Aircocheck monoblock - ${naam} - ${d.gemeente || ""}` : `Aircocheck - ${naam} - ${d.gemeente || ""}`).replace(/ - $/, "");
  if (form === "kras" && d.stap === "start") return `Kraskaart €${d.korting} · gegevens - ${naam} - ${d.postcode || ""}`.replace(/ - $/, "");
  if (form === "kras" && d.stap === "klaar") return `Kraskaart €${d.korting || "?"} · aangevuld - ${naam}`;
  if (form === "kras") return `Kraskaart €${d.korting || "?"} - ${naam} - ${d.gemeente || ""}`.replace(/ - $/, "");
  return d.lead_titel || `Website aanvraag - ${naam}`;
}

function externeIdWebsite(payload) {
  if (payload && payload.id) return "web:" + String(payload.id).slice(0, 100);
  const h = crypto.createHash("sha256").update(JSON.stringify((payload && payload.data) || {}) + "|" + ((payload && payload.created_at) || "")).digest("hex");
  return "web:h" + h.slice(0, 32);
}

function vanWebsite(payload, extra) {
  const form = payload.form_name || "offerte";
  const d = payload.data || {};
  const meta = isMeta(d);
  const paren = [["Titel", titelWebsite(form, d)], ["Herkomst", meta ? "Meta-advertentie (Facebook / Instagram) via website-flow" : "Website smartcooling.be"],
    ["Formulier", form], ["Inzending", payload.id ? `${payload.id}${payload.number ? " (nr. " + payload.number + ")" : ""}` : ""],
    ["Ingediend op", payload.created_at || ""]];
  const gehad = new Set();
  const neem = (k) => { if (gehad.has(k) || OVERSLAAN.has(k)) return; gehad.add(k); const v = d[k]; if (v == null || v === "") return; paren.push([LABELS[k] || mens(k), Array.isArray(v) ? v.join(", ") : (typeof v === "object" ? JSON.stringify(v) : v)]); };
  KLANT.forEach(neem);
  // aircocheck: ruimtes en vermogen leesbaar (in plaats van de ruwe JSON)
  let rooms = [];
  try { rooms = JSON.parse(d.ruimtes_json || "[]"); } catch (e) { rooms = []; }
  if (Array.isArray(rooms) && rooms.length) paren.push(["Ruimtes (detail)", rooms.map((r, i) => `Ruimte ${i + 1}: ${[r.type, r.m2].filter(Boolean).join(", ")}${r.kw ? " – ± " + String(r.kw).replace(".", ",") + " kW" : ""}`).join("\n")]);
  const m = monoInfo(d);
  if (m) {
    paren.push(["Monoblocks", (m.units || []).map((u) => `Monoblock ${u.nr}: ${u.model || ""} (${u.m2 || ""}, ${u.kw || ""}) – ${u.actief ? "€ " + u.prijs : "NIET MOGELIJK: " + (u.reden || "")}`).join("\n")]);
    paren.push(["Offerteregels (getoond aan de klant, excl. btw)", (m.lines || []).map((l) => `${l.t}: ${l.p == null ? (l.txt || "—") : "€ " + l.p}`).join("\n")]);
    if (m.totaal_excl != null) paren.push(["Richtprijs getoond", `€ ${m.totaal_excl} excl. btw`]);
  }
  for (const k of Object.keys(d)) if (!HERKOMST.includes(k)) neem(k);
  if (extra && extra.advies) paren.push(...extra.advies);
  HERKOMST.forEach(neem);
  const straat = [d.straat, d.huisnr].filter(Boolean).join(" ").trim();
  const titel = (extra && extra.titel) || titelWebsite(form, d);
  if (extra && extra.titel) paren[0][1] = titel;
  const rg = regels(paren);
  return {
    notities: notitie(titel, extra && extra.beschrijving, payload.created_at, rg),
    naam: volNaam(d) || d.naam_vol || d.email || "Onbekend", telefoon: txt(d.telefoon || d.gsm).slice(0, 40), email: txt(d.email).slice(0, 160),
    straat: straat.slice(0, 160), postcode: txt(d.postcode).slice(0, 12), gemeente: txt(d.gemeente).slice(0, 80),
    bron: meta ? "Meta" : "Website", externe_id: externeIdWebsite(payload), aanvraag: rg,
    richtprijs: m && m.totaal_excl != null ? `€ ${m.totaal_excl} excl. btw` : (extra && extra.band ? `${extra.band} (incl. plaatsing)` : ""),
    monoblock: Boolean(m) || /monoblock/i.test(d.systeem || ""),
    toestemming: true, // het formulier zegt "Door te verzenden gaat u akkoord met ons privacybeleid"
  };
}

// ---------- Meta-leadformulier (meta-leads-sync) ----------
// lead = ruwe Meta-lead {id, created_time, field_data, ad_name, campaign_name}; p = toPayload() van meta-leads-sync
function vanMeta(lead, formName, formId, p, beschrijving) {
  const d = (p && p.data) || {};
  const paren = [["Titel", d.lead_titel], ["Herkomst", "Meta-advertentie (Facebook / Instagram)"], ["Formulier", formName],
    ["Formulier-ID", formId && formId !== formName ? formId : ""], ["Advertentie", lead.ad_name], ["Campagne", lead.campaign_name],
    ["Meta lead-ID", lead.id], ["Aangemaakt in Meta", lead.created_time], ["Toestel / type", d.systeem], ["Aantal airco('s)", d.aantal],
    ["Grootte per ruimte", d.ruimtes_m2], ["Gewenste plaatsing", d.plaatsingsdatum], ["Gewenst belmoment", d.belmoment]];
  // alle antwoorden van het formulier, letterlijk (vraag → antwoord)
  for (const f of lead.field_data || []) paren.push([mens(f.name), (f.values || []).map(cleanMeta).join(", ")]);
  const rg = regels(paren);
  return {
    notities: notitie(d.lead_titel || "Meta-advertentie", beschrijving, lead.created_time, rg),
    naam: d.naam_vol || [d.voornaam, d.naam].filter(Boolean).join(" ") || d.email || "Onbekend", telefoon: txt(d.telefoon).slice(0, 40),
    email: txt(d.email).slice(0, 160), straat: txt(d.straat).slice(0, 160), postcode: txt(d.postcode).slice(0, 12), gemeente: txt(d.gemeente).slice(0, 80),
    bron: "Meta", externe_id: "meta:" + lead.id, aanvraag: rg, richtprijs: "", monoblock: /monoblock/i.test(d.systeem || ""),
    toestemming: true, // Meta-leadformulieren vragen altijd akkoord met het privacybeleid
  };
}

const isTestLead = (body) => [body.naam, body.email, body.telefoon, ...(body.aanvraag || []).map((x) => x.waarde)].some((v) => TEST_LEAD.test(String(v || "")));

// ---------- versturen: max. N pogingen, nooit een fout naar buiten ----------
// opts: attempts (3), timeoutMs (10000), waitMs ([2000, 5000]), deadline (ms-tijdstip waarna niets nieuws meer start)
async function stuur(body, opts) {
  opts = Object.assign({ attempts: 3, timeoutMs: 10000, waitMs: [2000, 5000], deadline: 0 }, opts || {});
  if (!ingesteld()) return { overgeslagen: "AFP_LEADS_URL/AFP_LEADS_KEY niet ingesteld" };
  if (isTestLead(body)) return { overgeslagen: "Meta-testlead" };
  const url = process.env.AFP_LEADS_URL.trim(), key = process.env.AFP_LEADS_KEY.trim();
  let host = "AFP"; try { host = new URL(url).host; } catch (e) { return { ok: false, fout: "AFP_LEADS_URL is geen geldig adres" }; }
  let laatste = "";
  for (let i = 0; i < opts.attempts; i++) {
    const rest = opts.deadline ? opts.deadline - Date.now() : Infinity;
    if (rest < 1500) { laatste = laatste || "geen tijd meer in deze run"; break; }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.min(opts.timeoutMs, rest - 500));
    let status = 0, wacht = opts.waitMs[Math.min(i, opts.waitMs.length - 1)];
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Sleutel": key }, body: JSON.stringify(body), signal: ctl.signal });
      status = r.status;
      const tekst = await r.text();
      if (r.ok) {
        let j = {}; try { j = JSON.parse(tekst); } catch (e) { j = {}; }
        console.log(`AFP: ${body.externe_id} → ${j.nieuw ? "nieuwe kaart" : j.bestond ? "al aanwezig (geen tweede kaart)" : "ontvangen"} (poging ${i + 1})`);
        return { ok: true, status, kaart_id: j.kaart_id || null, nieuw: Boolean(j.nieuw), bestond: Boolean(j.bestond), pogingen: i + 1 };
      }
      laatste = `HTTP ${status}: ${tekst.replace(/\s+/g, " ").slice(0, 200)}`;
      if (status === 429) { const ra = Number(r.headers.get("retry-after")) || 0; if (ra) wacht = Math.max(wacht, ra * 1000); }
      else if (status < 500 && status !== 408) { console.error(`AFP (${host}): ${body.externe_id} geweigerd – ${laatste}`); return { ok: false, status, fout: laatste, pogingen: i + 1 }; }
    } catch (e) {
      laatste = e.name === "AbortError" ? "geen antwoord binnen " + Math.round(Math.min(opts.timeoutMs, rest) / 1000) + " s" : (e.message || String(e));
    } finally { clearTimeout(t); }
    console.warn(`AFP (${host}): poging ${i + 1}/${opts.attempts} voor ${body.externe_id} mislukt – ${laatste}`);
    if (status === 429 && opts.stopBij429) return { ok: false, status, fout: laatste, rem: true, pogingen: i + 1 };
    if (i < opts.attempts - 1) {
      if (opts.deadline && Date.now() + wacht > opts.deadline - 1500) break;
      await sleep(wacht);
    }
  }
  console.error(`AFP (${host}): ${body.externe_id} NIET in AFP gezet – ${laatste}`);
  return { ok: false, fout: laatste, pogingen: opts.attempts };
}

// Website: gebruikt door lib/lead.js (processLead), na Odoo en de lead-mail.
async function stuurWebsiteLead(payload, opts) {
  try {
    if (!ingesteld()) return { overgeslagen: "niet ingesteld" };
    let extra = null;
    if ((payload.form_name || "") === "aircocheck" && !monoInfo(payload.data || {}) && opts && typeof opts.score === "function") {
      try {
        const s = opts.score(payload.data || {});
        extra = { band: s.band, advies: [["Leadtemperatuur (intern)", s.temp], ["Advies systeem (intern)", s.systeem], ["Totaal vermogen", `± ${String(Math.round(s.total * 10) / 10).replace(".", ",")} kW`],
          ["Multisplit-index", s.multiIndex], ["Merk-kader (intern)", (s.merken || []).join(" / ")], ["Prijsband (intern)", s.band ? s.band + " (incl. plaatsing)" : ""],
          ["Gemeentepagina", s.gemeentePagina !== "-" ? s.gemeentePagina : ""]] };
      } catch (e) { extra = null; }
    }
    extra = Object.assign(extra || {}, { titel: opts && opts.titel, beschrijving: opts && opts.beschrijving });
    return await stuur(vanWebsite(payload, extra), opts);
  } catch (e) { console.error("AFP: onverwachte fout (Odoo en mail zijn niet geraakt):", e.message); return { ok: false, fout: e.message }; }
}

// Meta: gebruikt door meta-leads-sync NA de hele Odoo-ronde. kandidaten = [{lead, formName, formId, payload, nieuwInOdoo}]
// store = Netlify Blobs-opslag (onthoudt welke Meta-leads al in AFP staan; zonder opslag enkel de leads die deze run nieuw waren).
// Max. `max` leads per run (rem van de webhook: 12/min per IP), stopt bij 429 of als de tijd van de geplande functie opraakt.
async function stuurMetaLeads(kandidaten, opts) {
  const o = Object.assign({ store: null, deadline: 0, max: 10, attempts: 3, timeoutMs: 6000, waitMs: [800, 2000] }, opts || {});
  const res = { verstuurd: 0, al: 0, fout: 0, wacht: 0, overgeslagen: 0 };
  try {
    if (!ingesteld()) return { ...res, uit: true };
    let gekend = null;
    if (o.store) { try { const l = await o.store.list({ prefix: "meta-" }); gekend = new Set((l.blobs || []).map((b) => b.key)); } catch (e) { console.warn("AFP: opslag niet leesbaar, enkel nieuwe leads:", e.message); gekend = null; } }
    let gestopt = false;
    for (const k of kandidaten) {
      const sleutel = "meta-" + k.lead.id;
      if (gekend ? gekend.has(sleutel) : !k.nieuwInOdoo) { res.overgeslagen++; continue; }
      if (gestopt || res.verstuurd + res.al + res.fout >= o.max) { res.wacht++; continue; }
      let beschrijving = k.beschrijving || "";
      if (!beschrijving && typeof o.beschrijving === "function") { try { beschrijving = (await o.beschrijving(k)) || ""; } catch (e) { console.warn("AFP: Odoo-beschrijving niet gelezen (notitie uit de formuliervelden):", e.message); } }
      const body = vanMeta(k.lead, k.formName, k.formId, k.payload, beschrijving);
      const r = await stuur(body, { attempts: o.attempts, timeoutMs: o.timeoutMs, waitMs: o.waitMs, deadline: o.deadline, stopBij429: true });
      if (r.ok) {
        r.bestond ? res.al++ : res.verstuurd++;
        if (o.store) { try { await o.store.set(sleutel, JSON.stringify({ at: new Date().toISOString(), kaart_id: r.kaart_id })); } catch (e) { console.warn("AFP: niet onthouden (volgende run opnieuw, AFP herkent het id):", e.message); } }
      } else if (r.overgeslagen) res.overgeslagen++;
      else {
        res.fout++;
        if (r.rem || !r.status || r.status >= 500) gestopt = true; // AFP onbereikbaar/overbelast: de rest volgende run
      }
    }
  } catch (e) { console.error("AFP: onverwachte fout in Meta-ronde (Odoo is niet geraakt):", e.message); }
  console.log(`AFP Meta-ronde: ${res.verstuurd} nieuw, ${res.al} al aanwezig, ${res.fout} mislukt, ${res.wacht} volgende run, ${res.overgeslagen} niet nodig`);
  return res;
}

module.exports = { ingesteld, stuur, stuurWebsiteLead, stuurMetaLeads, vanWebsite, vanMeta, externeIdWebsite, regels, htmlNaarTekst, notitie };
