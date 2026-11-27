// Tests voor de AFP-koppeling (lib/afp.js) — enkel fictieve gegevens.
//   npm test                         → eenheidstests (geen netwerk)
//   + integratie als deze env bestaan (zie RAPPORT opdracht 139): AFP_TEST_BASE, AFP_TEST_TOKEN (aangemelde kantoorgebruiker),
//     AFP_TEST_WEBHOOK, AFP_TEST_KEY (lokale AFP e2e-server) en ODOO_TEST_URL (nep-Odoo). Externe diensten (Brevo, OSM, Meta) worden
//     onderschept: er vertrekt niets naar buiten.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const FN = path.join(__dirname, "..", "functions");
const echteFetch = global.fetch;
const verkeer = [];
let graphLeads = [];
global.fetch = async (url, init) => {
  const u = String(url);
  verkeer.push({ url: u, headers: (init && init.headers) || {} });
  if (/api\.brevo\.com|nominatim|project-osrm/.test(u)) return new Response("[]", { status: 200 });
  if (u.startsWith("https://graph.facebook.com/")) {
    const p = u.slice("https://graph.facebook.com/v21.0/".length);
    if (/^\d+\?fields=access_token/.test(p)) return Response.json({ access_token: "nep-pagina" });
    if (/^\d+\?fields=name/.test(p)) return Response.json({ name: "Fictief | NL | Mitsubishi MSZ-HR" });
    if (/^\d+\/leads\?/.test(p)) return Response.json({ data: graphLeads });
    return Response.json({ error: { message: "onbekend in test: " + p } });
  }
  if (!/^http:\/\/127\.0\.0\.1:/.test(u)) throw new Error("test: geen extern verkeer toegestaan naar " + u);
  return echteFetch(url, init);
};
process.env.FAST_TEST = "1";
const fris = (m) => { delete require.cache[require.resolve(path.join(FN, m))]; return require(path.join(FN, m)); };
const afpUit = () => { delete process.env.AFP_LEADS_URL; delete process.env.AFP_LEADS_KEY; };

const WEB = (id, extra = {}) => ({
  id, number: 7, created_at: "2026-11-27T10:00:00.000Z", form_name: "offerte",
  data: Object.assign({ voornaam: "Fictief", naam: "Test Web " + id, telefoon: "0470 00 " + id.slice(-2) + " 11", email: `web${id}@voorbeeld.test`,
    straat: "Proefstraat", huisnr: "9", postcode: "3550", gemeente: "Heusden-Zolder", systeem: "Daikin Perfera", aantal: "2", ruimte: ["Living", "Slaapkamer"],
    plaatsingsdatum: "Binnen 1 maand", belmoment: "Na 17 u", bericht: "Graag een offerte.\nOok voor de zolder?", bron_pagina: "/daikin-airco/",
    "bot-field": "", ip: "203.0.113.9", user_agent: "Nep" }, extra),
});
const META = (id, extra = []) => ({
  id, created_time: "2026-11-27T09:00:00+0000", ad_name: "Fictieve advertentie", campaign_name: "Fictieve campagne najaar",
  field_data: [{ name: "volledige_naam", values: ["Fictief Meta " + id.slice(-3)] }, { name: "telefoonnummer", values: ["+32470" + id.slice(-6)] },
    { name: "e-mailadres", values: [`meta${id.slice(-4)}@voorbeeld.test`] }, { name: "postcode", values: ["3500"] },
    { name: "hoeveel_ruimtes_wilt_u_koelen?", values: ["2_ruimtes"] }, { name: "ruimte_1", values: ["Living"] }, { name: "ruimte_1_grootte", values: ["20_–_30_m²"] },
    { name: "wanneer_wilt_u_de_airco_laten_plaatsen?", values: ["zo_snel_mogelijk"] }, ...extra],
});

// ---------------- eenheidstests ----------------
test("zonder AFP_LEADS_URL/KEY: niets extra", async () => {
  afpUit();
  const afp = fris("lib/afp.js");
  assert.equal(afp.ingesteld(), false);
  const n = verkeer.length;
  const r = await afp.stuurWebsiteLead(WEB("aaaa01"), {});
  assert.ok(r.overgeslagen);
  assert.equal(verkeer.length, n, "geen netwerkverkeer");
});

test("website → webhook-inhoud: bron, externe_id, titel en alle velden", () => {
  const afp = fris("lib/afp.js");
  const b = afp.vanWebsite(WEB("sub-123"));
  assert.equal(b.bron, "Website");
  assert.equal(b.externe_id, "web:sub-123");
  assert.equal(b.naam, "Fictief Test Web sub-123");
  assert.equal(b.straat, "Proefstraat 9");
  assert.equal(b.toestemming, true);
  const lab = Object.fromEntries(b.aanvraag.map((x) => [x.label, x.waarde]));
  assert.equal(lab["Titel"], "Website aanvraag - Fictief Test Web sub-123");
  assert.equal(lab["Toestel / type"], "Daikin Perfera");
  assert.equal(lab["Type ruimte"], "Living, Slaapkamer");
  assert.equal(lab["Bericht"], "Graag een offerte.\nOok voor de zolder?");
  assert.equal(lab["Gewenst belmoment"], "Na 17 u");
  assert.equal(lab["Bronpagina"], "/daikin-airco/");
  for (const weg of ["Ip", "User agent", "Bot field"]) assert.ok(!(weg in lab), weg + " gaat niet mee");
  assert.ok(b.aanvraag.length <= 40 && b.aanvraag.every((x) => x.waarde.length <= 500 && x.label.length <= 80));
});

test("Meta-lead via website-flow (bron_pagina Meta-advertentie) → bron Meta + Meta-titel", () => {
  const afp = fris("lib/afp.js");
  const b = afp.vanWebsite(WEB("x1", { bron_pagina: "Meta-advertentie – Mitsubishi MSZ-HR", lead_titel: "Meta Mitsubishi MSZ-HR - Fictief X" }));
  assert.equal(b.bron, "Meta");
  assert.equal(b.aanvraag[0].waarde, "Meta Mitsubishi MSZ-HR - Fictief X");
});

test("aircocheck monoblock: monoblock + richtprijs + leesbare regels i.p.v. JSON", () => {
  const afp = fris("lib/afp.js");
  const mono = { units: [{ nr: 1, model: "Fictief Polar 2,5", m2: "20 m²", kw: "2,5 kW", actief: true, prijs: 1490 }], lines: [{ t: "Plaatsing", p: 250 }], totaal_excl: 1740 };
  const b = afp.vanWebsite({ id: "m1", form_name: "aircocheck", data: { voornaam: "Fictief", naam: "Mono", gsm: "0470 99 99 01", gemeente: "Genk", systeem: "Monoblock", mono_json: JSON.stringify(mono) } });
  assert.equal(b.monoblock, true);
  assert.equal(b.telefoon, "0470 99 99 01");
  assert.equal(b.richtprijs, "€ 1740 excl. btw");
  const t = b.aanvraag.map((x) => x.label + "=" + x.waarde).join("\n");
  assert.match(t, /Titel=Aircocheck monoblock - Fictief Mono - Genk/);
  assert.match(t, /Monoblock 1: Fictief Polar 2,5/);
  assert.doesNotMatch(t, /"units"/);
});

test("lange waarden worden gesplitst, max. 40 regels", () => {
  const afp = fris("lib/afp.js");
  const r = afp.regels([["Bericht", "x".repeat(1200)]]);
  assert.deepEqual(r.map((x) => x.label), ["Bericht", "Bericht (vervolg)", "Bericht (vervolg)"]);
  assert.equal(r.map((x) => x.waarde).join("").length, 1200);
  const veel = afp.regels(Array.from({ length: 60 }, (_, i) => ["Veld " + i, "w" + i]));
  assert.equal(veel.length, 40);
  assert.equal(veel[39].label, "Overige velden");
});

test("Meta-formulier → alle antwoorden, externe_id meta:<lead-ID>", () => {
  const afp = fris("lib/afp.js");
  const lead = META("900000000000777");
  const b = afp.vanMeta(lead, "Fictief | NL | Mitsubishi MSZ-HR", "123", { data: { naam_vol: "Fictief Meta 777", telefoon: "+32470000777", email: "m@voorbeeld.test",
    postcode: "3500", gemeente: "Hasselt", systeem: "Mitsubishi MSZ-HR", lead_titel: "Meta Mitsubishi MSZ-HR - Fictief Meta 777 (Hasselt)", aantal: "2 ruimtes" } });
  assert.equal(b.externe_id, "meta:900000000000777");
  assert.equal(b.bron, "Meta");
  const lab = Object.fromEntries(b.aanvraag.map((x) => [x.label, x.waarde]));
  assert.equal(lab["Titel"], "Meta Mitsubishi MSZ-HR - Fictief Meta 777 (Hasselt)");
  assert.equal(lab["Campagne"], "Fictieve campagne najaar");
  assert.equal(lab["Advertentie"], "Fictieve advertentie");
  assert.equal(lab["Formulier"], "Fictief | NL | Mitsubishi MSZ-HR");
  assert.equal(lab["Meta lead-ID"], "900000000000777");
  assert.equal(lab["Hoeveel ruimtes wilt u koelen"], "2 ruimtes");
  assert.equal(lab["Ruimte 1 grootte"], "20–30 m²");
  assert.equal(lab["Wanneer wilt u de airco laten plaatsen"], "zo snel mogelijk");
});

test("Meta-testlead gaat nooit naar AFP", async () => {
  process.env.AFP_LEADS_URL = "http://127.0.0.1:9/api/leads/webhook/xxxxxxxxxxxxxxxxxxxx"; process.env.AFP_LEADS_KEY = "lk_test";
  const afp = fris("lib/afp.js");
  const n = verkeer.length;
  const r = await afp.stuur({ naam: "<test lead: dummy data for full_name>", email: "test@meta.com", aanvraag: [], externe_id: "meta:1" }, {});
  assert.equal(r.overgeslagen, "Meta-testlead");
  assert.equal(verkeer.length, n);
  afpUit();
});

test("Meta-ronde met opslag: gekende leads overslaan, mislukte volgende run opnieuw, max per run", async () => {
  process.env.AFP_LEADS_URL = "http://127.0.0.1:9/api/leads/webhook/xxxxxxxxxxxxxxxxxxxx"; process.env.AFP_LEADS_KEY = "lk_test";
  const afp = fris("lib/afp.js");
  const opslag = new Map([["meta-1", "{}"]]);
  const store = { list: async () => ({ blobs: [...opslag.keys()].map((key) => ({ key })) }), set: async (k, v) => opslag.set(k, v) };
  const k = (id) => ({ lead: META(String(id)), formName: "F", formId: "1", payload: { data: { naam_vol: "Fictief " + id, telefoon: "0470" + id } }, nieuwInOdoo: false });
  const r = await afp.stuurMetaLeads([k(1), k(2), k(3)], { store, attempts: 1, timeoutMs: 500, waitMs: [10] });
  assert.equal(r.overgeslagen, 1, "meta-1 al in AFP");
  assert.equal(r.fout, 1, "AFP onbereikbaar → één poging, dan stoppen");
  assert.equal(r.wacht, 1, "rest volgende run");
  assert.ok(!opslag.has("meta-2"), "mislukte lead niet onthouden → volgende run opnieuw");
  afpUit();
});

// ---------------- integratie: lokale AFP e2e-server + nep-Odoo ----------------
const I = process.env.AFP_TEST_BASE && process.env.AFP_TEST_TOKEN && process.env.AFP_TEST_WEBHOOK && process.env.AFP_TEST_KEY && process.env.ODOO_TEST_URL;
const afpGet = async (p) => (await echteFetch(process.env.AFP_TEST_BASE + "/api" + p, { headers: { Authorization: "Bearer " + process.env.AFP_TEST_TOKEN } })).json();
const kaartenVan = async (q) => (await afpGet("/leads/zoek?q=" + encodeURIComponent(q))).items || [];
const odooStatus = async () => (await echteFetch(process.env.ODOO_TEST_URL + "/_nep/status")).json();
function odooEnv() { Object.assign(process.env, { ODOO_URL: process.env.ODOO_TEST_URL, ODOO_DB: "nep", ODOO_LOGIN: "nep", ODOO_API_KEY: "nep" }); delete process.env.BREVO_API_KEY; }
const afpAan = () => { process.env.AFP_LEADS_URL = process.env.AFP_TEST_WEBHOOK; process.env.AFP_LEADS_KEY = process.env.AFP_TEST_KEY; };

test("INTEGRATIE website: Odoo + AFP, tweede keer geen tweede kaart, alle velden in de kaart", { skip: !I }, async () => {
  odooEnv(); afpAan();
  const { processLead } = fris("lib/lead.js");
  const sid = "int-web-" + Date.now();
  const tel = "0471" + String(Date.now()).slice(-6); // uniek per run (herhaalbaar op dezelfde server)
  const p = WEB(sid, { telefoon: tel, email: `integratie.${tel}@voorbeeld.test` });
  const voor = (await odooStatus()).site_creates.length;
  const r1 = await processLead(p, { attempts: 1, odooTimeout: 5000, waitMs: [10] });
  assert.ok(r1.odoo && r1.odoo.leadId, "Odoo-lead gemaakt: " + JSON.stringify(r1.odoo));
  assert.equal(r1.afp.ok, true); assert.equal(r1.afp.nieuw, true);
  const r2 = await processLead(p, { attempts: 1, odooTimeout: 5000, waitMs: [10] });
  assert.equal(r2.afp.ok, true); assert.equal(r2.afp.bestond, true, "tweede keer: bestond");
  assert.equal(r2.afp.kaart_id, r1.afp.kaart_id);
  assert.equal((await odooStatus()).site_creates.length, voor + 2, "Odoo werkt zoals vroeger (elke inzending een lead)");
  const ks = await kaartenVan(tel);
  assert.equal(ks.length, 1, "één kaart in AFP");
  const d = await afpGet("/leads/kaarten/" + ks[0].id);
  assert.equal(d.bron, "Website");
  assert.equal(d.klant.telefoon.replace(/\s/g, ""), "+32" + tel.slice(1));
  assert.equal(d.klant.straat, "Proefstraat 9");
  const lab = Object.fromEntries(d.aanvraag.map((x) => [x.label, x.waarde]));
  assert.equal(lab["Titel"], `Website aanvraag - Fictief Test Web ${sid}`);
  assert.equal(lab["Toestel / type"], "Daikin Perfera");
  assert.equal(lab["Gewenste plaatsing"], "Binnen 1 maand");
  assert.ok(String(lab["Bericht"]).includes("zolder"));
  assert.match(String(d.plaats), /Nieuwe lead/);
});

test("INTEGRATIE website: AFP onbereikbaar → Odoo lukt gewoon, 3 pogingen, fout gelogd", { skip: !I }, async () => {
  odooEnv();
  process.env.AFP_LEADS_URL = "http://127.0.0.1:9/api/leads/webhook/xxxxxxxxxxxxxxxxxxxx"; process.env.AFP_LEADS_KEY = "lk_onbereikbaar";
  const { processLead } = fris("lib/lead.js");
  const fouten = []; const oud = console.error; console.error = (...a) => { fouten.push(a.join(" ")); oud(...a); };
  const r = await processLead(WEB("int-down-" + Date.now(), { telefoon: "0471 00 00 99" }), { attempts: 1, odooTimeout: 5000, waitMs: [10] });
  console.error = oud;
  assert.ok(r.odoo && r.odoo.leadId, "Odoo-lead toch gemaakt");
  assert.equal(r.afp.ok, false); assert.equal(r.afp.pogingen, 3);
  assert.ok(fouten.some((f) => /NIET in AFP gezet/.test(f)), "fout gelogd");
  assert.ok(!fouten.join(" ").includes("lk_onbereikbaar"), "sleutel nooit in de log");
});

test("INTEGRATIE website: foute sleutel → geen herhaling, Odoo lukt", { skip: !I }, async () => {
  odooEnv(); afpAan(); process.env.AFP_LEADS_KEY = "lk_fout";
  const { processLead } = fris("lib/lead.js");
  const r = await processLead(WEB("int-key-" + Date.now(), { telefoon: "0471 00 00 98" }), { attempts: 1, odooTimeout: 5000, waitMs: [10] });
  assert.ok(r.odoo.leadId); assert.equal(r.afp.status, 401); assert.equal(r.afp.pogingen, 1);
});

test("INTEGRATIE Meta-sync: Odoo + AFP met alle antwoorden, testlead nergens, tweede run geen dubbel", { skip: !I }, async () => {
  odooEnv(); afpAan();
  Object.assign(process.env, { META_ACCESS_TOKEN: "nep", META_PAGE_ID: "111", META_FORM_IDS: "222" });
  const sync = fris("meta-leads-sync.js");
  const t0 = String(Date.now()).slice(-12), id1 = "9" + t0 + "91", id2 = "8" + t0 + "82"; // verschillende klanten (telefoon = laatste 6 cijfers)
  graphLeads = [META(id1, [{ name: "opmerking", values: ["Fictieve vraag over premie"] }]), META(id2),
    { id: "777", created_time: "2026-11-27T09:00:00+0000", field_data: [{ name: "full_name", values: ["<test lead: dummy data for full_name>"] }, { name: "email", values: ["test@meta.com"] }] }];
  const voor = (await odooStatus()).site_creates.length;
  const r1 = JSON.parse((await sync.handler({})).body);
  assert.equal(r1.nieuw, 2, "2 nieuw in Odoo (testlead niet)");
  assert.equal(r1.afp.verstuurd, 2, "2 nieuw in AFP");
  assert.equal((await odooStatus()).site_creates.length, voor + 2);
  const ks = await kaartenVan("+32470" + id1.slice(-6));
  assert.equal(ks.length, 1);
  const d = await afpGet("/leads/kaarten/" + ks[0].id);
  assert.equal(d.bron, "Meta");
  const lab = Object.fromEntries(d.aanvraag.map((x) => [x.label, x.waarde]));
  assert.match(lab["Titel"], /^Meta Mitsubishi MSZ-HR - Fictief Meta/);
  assert.equal(lab["Meta lead-ID"], id1);
  assert.equal(lab["Opmerking"], "Fictieve vraag over premie");
  assert.equal(lab["Campagne"], "Fictieve campagne najaar");
  assert.ok((await kaartenVan("test@meta.com")).length === 0, "testlead niet in AFP");
  // tweede run (zelfde 48 u-venster): al in Odoo → zonder opslag niet opnieuw; ook mét opnieuw versturen geen tweede kaart
  const r2 = JSON.parse((await sync.handler({})).body);
  assert.equal(r2.nieuw, 0);
  const afp = fris("lib/afp.js");
  const nogmaals = await afp.stuur(afp.vanMeta(graphLeads[0], "F", "222", { data: { naam_vol: "x", telefoon: "+32470" + id1.slice(-6) } }), { attempts: 1 });
  assert.equal(nogmaals.bestond, true);
  assert.equal((await kaartenVan("+32470" + id1.slice(-6))).length, 1, "nog altijd één kaart");
});

test("INTEGRATIE Meta-sync: AFP onbereikbaar → Odoo-ronde lukt, functie geeft 200", { skip: !I }, async () => {
  odooEnv();
  process.env.AFP_LEADS_URL = "http://127.0.0.1:9/api/leads/webhook/xxxxxxxxxxxxxxxxxxxx"; process.env.AFP_LEADS_KEY = "lk_onbereikbaar";
  Object.assign(process.env, { META_ACCESS_TOKEN: "nep", META_PAGE_ID: "111", META_FORM_IDS: "222", AFP_BUDGET_MS: "8000" });
  const sync = fris("meta-leads-sync.js");
  graphLeads = [META("7" + String(Date.now()).slice(-14))];
  const res = await sync.handler({});
  const r = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(r.nieuw, 1, "Odoo-lead gemaakt");
  assert.equal(r.afp.fout, 1);
  delete process.env.AFP_BUDGET_MS;
});
