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
    { name: "e-mailadres", values: [`meta${id.slice(-10)}@voorbeeld.test`] }, { name: "postcode", values: ["3500"] },
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

// ---------------- tijdsgrenzen (controle 139): AFP mag een functie nooit tot aan haar time-out ophouden ----------------
const http = require("http");
async function nepAfp(antwoord) { // lokale nep-webhook; antwoord(n, res) beslist per aanvraag
  let n = 0;
  const open = new Set();
  const srv = http.createServer((req, res) => { open.add(res); req.resume(); req.on("end", () => antwoord(++n, res)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  process.env.AFP_LEADS_URL = `http://127.0.0.1:${srv.address().port}/api/leads/webhook/nep-token-abcdefghijklmnop`;
  process.env.AFP_LEADS_KEY = "lk_nep-sleutel-tijdsgrens";
  return { aantal: () => n, stop: () => new Promise((r) => { for (const x of open) x.destroy(); srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }) };
}

test("429 met een absurde Retry-After: wachttijd begrensd, daarna gewoon verder", async () => {
  const s = await nepAfp((n, res) => { if (n < 3) { res.writeHead(429, { "Retry-After": "86400" }); res.end("{}"); } else { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true,"nieuw":true,"kaart_id":"k1"}'); } });
  try {
    const afp = fris("lib/afp.js");
    const t = Date.now();
    const r = await afp.stuur(afp.vanWebsite(WEB("ra-001")), { attempts: 3, waitMs: [10, 10], maxWachtMs: 150 });
    assert.equal(r.ok, true); assert.equal(r.pogingen, 3);
    assert.ok(Date.now() - t < 3000, "wacht niet de gevraagde 24 u");
    assert.match(afp.stuur.toString() + require("fs").readFileSync(path.join(FN, "lib/afp.js"), "utf8"), /const MAX_WACHT = 65000/, "standaardgrens 65 s");
  } finally { await s.stop(); afpUit(); }
});

test("noodpad (10 s): AFP die niet antwoordt stopt vóór de grens; te weinig tijd → geen aanvraag", async () => {
  const s = await nepAfp(() => { /* antwoordt nooit */ });
  try {
    const afp = fris("lib/afp.js");
    let t = Date.now();
    let r = await afp.stuurWebsiteLead(WEB("dl-001"), { attempts: 1, timeoutMs: 3000, deadline: Date.now() + 2000 });
    assert.equal(r.ok, false); assert.equal(s.aantal(), 1);
    assert.ok(Date.now() - t < 1900, `afgebroken vóór de grens (${Date.now() - t} ms)`);
    t = Date.now();
    r = await afp.stuurWebsiteLead(WEB("dl-002"), { attempts: 1, timeoutMs: 3000, deadline: Date.now() + 1000 });
    assert.equal(r.ok, false); assert.equal(s.aantal(), 1, "geen nieuwe aanvraag meer");
    assert.ok(Date.now() - t < 200);
    // submission-created geeft de grens echt door
    assert.match(require("fs").readFileSync(path.join(FN, "submission-created.js"), "utf8"), /afpDeadline: start \+ 9000/);
    assert.match(require("fs").readFileSync(path.join(FN, "lib/lead.js"), "utf8"), /deadline: opts\.afpDeadline \|\| 0/);
  } finally { await s.stop(); afpUit(); }
});

test("Meta-ronde (30 s): trage opslag en trage Odoo houden de functie niet op", async () => {
  const s = await nepAfp((n, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true,"nieuw":true,"kaart_id":"k"}'); });
  try {
    const afp = fris("lib/afp.js");
    const nooit = () => new Promise(() => {});
    const kand = ["1", "2", "3"].map((x) => ({ lead: META("99900000000000" + x), formName: "Fictief", formId: "1", payload: { data: { lead_titel: "Meta Fictief " + x, naam_vol: "Fictief " + x, telefoon: "+3247000000" + x } }, nieuwInOdoo: true }));
    const t = Date.now();
    const r = await afp.stuurMetaLeads(kand, { store: { list: nooit, set: async () => {} }, beschrijving: nooit, deadline: Date.now() + 9000 });
    const duur = Date.now() - t;
    assert.ok(duur < 9000, `klaar vóór de grens (${duur} ms)`);
    assert.ok(r.verstuurd >= 1 && r.verstuurd + r.wacht === 3, JSON.stringify(r));
    const r2 = await afp.stuurMetaLeads(kand, { beschrijving: nooit, deadline: Date.now() + 2000 });
    assert.equal(r2.verstuurd, 0); assert.equal(r2.wacht, 3, "te weinig tijd: alles naar de volgende run");
  } finally { await s.stop(); afpUit(); }
});

// ---------------- integratie: lokale AFP e2e-server + nep-Odoo ----------------
const I = process.env.AFP_TEST_BASE && process.env.AFP_TEST_TOKEN && process.env.AFP_TEST_WEBHOOK && process.env.AFP_TEST_KEY && process.env.ODOO_TEST_URL;
// Let op: de webhook remt 12 aanvragen per minuut per IP (ook lokaal). Deze reeks doet er 11: start de AFP-testserver vers per run.
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

// ---------------- Notities: zelfde inhoud als de Odoo-beschrijving ----------------
test("html van de Odoo-beschrijving → platte tekst met dezelfde blokken en rijen", () => {
  const afp = fris("lib/afp.js");
  const t = afp.htmlNaarTekst('<p style="x"><b>KOP</b> &nbsp; <span style="y">HEET</span></p><h4 style="m">Klant</h4><table><tr><td style="p">Naam</td><td>Jan &amp; An</td></tr>' +
    '<tr><td>Grootte</td><td>Living: 20–30 m²<br>Slaapkamer: &lt; 20 m²</td></tr></table><h4>Herkomst</h4><table><tr><td>Bron</td><td>/x/</td></tr></table>');
  assert.equal(t, "KOP   HEET\n\n— Klant —\nNaam: Jan & An\nGrootte: Living: 20–30 m²\n  Slaapkamer: < 20 m²\n\n— Herkomst —\nBron: /x/");
});

// Onafhankelijke lezer van de Odoo-html (voor de vergelijking): [{blok, label, waarde}]
const kaal = (h) => String(h).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
function odooRijen(html) {
  const uit = [];
  for (const b of String(html).matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>\s*<table[^>]*>([\s\S]*?)<\/table>/g))
    for (const r of b[2].matchAll(/<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) uit.push({ blok: kaal(b[1]), label: kaal(r[1]), waarde: kaal(r[2]) });
  return uit;
}
// Zelfde rij in de AFP-notitie: binnen het blok "— blok —" de regel "label: waarde" (met vervolgregels)
function afpWaarde(notitie, blok, label) {
  const delen = notitie.split(/\n— (.+?) —\n/); // [kop, blok1, tekst1, blok2, tekst2, …]
  for (let i = 1; i < delen.length; i += 2) {
    if (delen[i] !== blok) continue;
    const regels = delen[i + 1].split("\n");
    const s = regels.findIndex((r) => r.startsWith(label + ": ") || r === label + ":");
    if (s < 0) continue;
    let w = regels[s].slice(label.length + 1);
    for (let j = s + 1; j < regels.length && /^ {2}/.test(regels[j]); j++) w += " " + regels[j];
    return w.replace(/\s+/g, " ").trim();
  }
  return null;
}
const VERSLAG = [];
function naastElkaar(naam, odooHtml, notitie) {
  const rijen = odooRijen(odooHtml);
  assert.ok(rijen.length >= 5, naam + ": Odoo-beschrijving heeft rijen (" + rijen.length + ")");
  VERSLAG.push(`\n### ${naam}\n\n| Blok | Veld | In Odoo (beschrijving) | In AFP (Notities) | Gelijk |\n|---|---|---|---|---|`);
  let fout = 0;
  for (const r of rijen) {
    const a = afpWaarde(notitie, r.blok, r.label);
    const ok = a === r.waarde; if (!ok) fout++;
    VERSLAG.push(`| ${r.blok} | ${r.label} | ${r.waarde.replace(/\|/g, "/")} | ${String(a).replace(/\|/g, "/")} | ${ok ? "ja" : "**NEE**"} |`);
  }
  const kop = kaal((String(odooHtml).match(/^<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");
  if (kop) { const ok = notitie.replace(/\s+/g, " ").includes(kop); if (!ok) fout++; VERSLAG.push(`| (kop) | — | ${kop} | ${ok ? kop : "ontbreekt"} | ${ok ? "ja" : "**NEE**"} |`); }
  assert.equal(fout, 0, naam + ": elk veld van de Odoo-beschrijving staat gelijk in de AFP-notitie");
  return rijen.length;
}
const odooLead = async (id) => (await odooStatus()).leads.find((l) => l.id === id);
const uniek = () => "047" + String(Date.now()).slice(-7);

test("INTEGRATIE Notities: Odoo-beschrijving en AFP-notitie naast elkaar (website offerte, aircocheck, monoblock) + klant op de klant", { skip: !I }, async () => {
  odooEnv(); afpAan();
  const { processLead } = fris("lib/lead.js");
  const gevallen = [
    ["Website-formulier offerte", (tel) => WEB("cmp-" + tel, { telefoon: tel, email: `cmp.${tel}@voorbeeld.test`, bericht: "Graag een offerte voor <2 ruimtes> & de zolder.\nBel na 17 u." })],
    ["Website Aircocheck (airco met buitenunit)", (tel) => ({ id: "ac-" + tel, created_at: "2026-11-27T10:00:00.000Z", form_name: "aircocheck", data: {
      voornaam: "Fictief", naam: "Check " + tel, gsm: tel, email: `ac.${tel}@voorbeeld.test`, straat: "Testlaan 4", postcode: "3500", gemeente: "Hasselt", dagdeel: "Voormiddag",
      systeem: "Airco met buitenunit", locatie: "Woning", ruimtes: "Living (30 m²) | Slaapkamer (14 m²)", ruimtes_json: JSON.stringify([{ type: "Living", m2: "30 m²", kw: 3.5 }, { type: "Slaapkamer", m2: "14 m²", kw: 2.0 }]),
      buitenunits: "1", wensen: "Stil, Bediening via app", verwarming: "Bijverwarmen", bron_pagina: "/aircocheck/", landingspagina: "/airco/hasselt/", apparaat: "mobiel", duur_sec: "185" } })],
    ["Website Aircocheck monoblock (richtprijs getoond)", (tel) => ({ id: "mo-" + tel, created_at: "2026-11-27T10:00:00.000Z", form_name: "aircocheck", data: {
      voornaam: "Fictief", naam: "Mono " + tel, gsm: tel, email: `mo.${tel}@voorbeeld.test`, straat: "Monoweg 2", postcode: "3600", gemeente: "Genk", dagdeel: "Avond", systeem: "Monoblock",
      mono_checks: "Buitenmuur: ja | Stopcontact: ja", mono_extras: "Wifi-module", bron_pagina: "/monoblock-airco/", landingspagina: "/monoblock-airco/", apparaat: "pc", duur_sec: "120",
      mono_json: JSON.stringify({ units: [{ nr: 1, model: "Fictief Polar 2,5", m2: "20 m²", kw: "2,5 kW", actief: true, prijs: 1490 }], lines: [{ t: "Toestel", p: 1490 }, { t: "Plaatsing", p: 250 }], totaal_excl: 1740 }) } })],
  ];
  for (const [naam, maak] of gevallen) {
    const tel = uniek(); const p = maak(tel);
    const r = await processLead(p, { attempts: 1, odooTimeout: 5000, waitMs: [10] });
    assert.ok(r.odoo && r.odoo.leadId && r.afp && r.afp.nieuw, naam + ": Odoo + AFP");
    const o = await odooLead(r.odoo.leadId);
    const d = await afpGet("/leads/kaarten/" + r.afp.kaart_id);
    assert.equal(d.notities.split("\n")[0], o.name, naam + ": eerste regel van de notitie = titel in Odoo");
    naastElkaar(naam, o.description, d.notities);
    // klantgegevens op de klant zelf (niet enkel in de notitie)
    const dd = p.data;
    assert.equal(d.klant.naam, [dd.voornaam, dd.naam].join(" "), naam + ": naam op de klant");
    assert.equal(d.klant.telefoon.replace(/\s/g, ""), "+32" + tel.slice(1), naam + ": telefoon +32 op de klant");
    assert.equal(d.klant.email, dd.email, naam + ": e-mail op de klant");
    assert.equal(d.klant.straat, [dd.straat, dd.huisnr].filter(Boolean).join(" "), naam + ": straat op de klant");
    assert.equal(d.klant.postcode, dd.postcode); assert.equal(d.klant.gemeente, dd.gemeente, naam + ": gemeente op de klant");
    const kl = await afpGet("/customers/" + d.klant.id);
    assert.equal(kl.gemeente, dd.gemeente, naam + ": ook op de klantkaart");
    await new Promise((x) => setTimeout(x, 3));
  }
});

test("INTEGRATIE Notities Meta: nieuwe lead én lead die al in Odoo stond — notitie = Odoo-beschrijving", { skip: !I }, async () => {
  odooEnv(); afpAan();
  Object.assign(process.env, { META_ACCESS_TOKEN: "nep", META_PAGE_ID: "111", META_FORM_IDS: "222" });
  const sync = fris("meta-leads-sync.js");
  const t0 = String(Date.now()).slice(-12), id1 = "6" + t0 + "61", id2 = "5" + t0 + "52";
  const extra = [{ name: "straat_en_nummer", values: ["Metaweg 7"] }, { name: "plaats", values: ["Hasselt"] }, { name: "wanneer_mogen_we_u_bellen?", values: ["na_17u"] }, { name: "opmerking", values: ["Fictieve vraag over premie"] }];
  // (a) nieuw via de geplande functie
  graphLeads = [META(id1, extra)];
  const r1 = JSON.parse((await sync.handler({})).body);
  assert.equal(r1.nieuw, 1); assert.equal(r1.afp.verstuurd, 1);
  const tel1 = "+32470" + id1.slice(-6);
  const k1 = (await kaartenVan(tel1))[0]; const d1 = await afpGet("/leads/kaarten/" + k1.id);
  const o1 = (await odooStatus()).leads.find((l) => String(l.description).includes("Meta lead-ID: " + id1));
  assert.equal(d1.notities.split("\n")[0], o1.name, "titel zoals in Odoo: " + o1.name);
  assert.match(o1.name, /^Meta Mitsubishi MSZ-HR - Fictief Meta/);
  naastElkaar("Meta-leadformulier (nieuw, via meta-leads-sync)", o1.description, d1.notities);
  for (const stuk of ["Campagne: Fictieve campagne najaar", "Advertentie: Fictieve advertentie", "Formulier: Fictief | NL | Mitsubishi MSZ-HR", "Meta lead-ID: " + id1, "opmerking: Fictieve vraag over premie"])
    assert.ok(d1.notities.replace(/\n {2}/g, "\n").includes(stuk), "notitie bevat: " + stuk);
  assert.equal(d1.klant.telefoon.replace(/\s/g, ""), tel1); assert.equal(d1.klant.straat, "Metaweg 7"); assert.equal(d1.klant.postcode, "3500"); assert.equal(d1.klant.gemeente, "Hasselt");
  assert.equal(d1.klant.email, `meta${id1.slice(-10)}@voorbeeld.test`); assert.equal(d1.bron, "Meta");
  // (b) stond al in Odoo (AFP lukte eerder niet / lead van vóór de koppeling): beschrijving wordt uit Odoo gelezen
  const lead2 = META(id2, extra); const p2 = sync._test.toPayload(lead2, "Fictief | NL | Mitsubishi MSZ-HR");
  const { processLead } = fris("lib/lead.js");
  const uit = await processLead(p2, { attempts: 1, odooTimeout: 5000, waitMs: [10], afp: false });
  assert.ok(uit.odoo.leadId && !uit.afp, "enkel in Odoo");
  const afp = fris("lib/afp.js");
  const opslag = new Map(); const store = { list: async () => ({ blobs: [...opslag.keys()].map((key) => ({ key })) }), set: async (k, v) => opslag.set(k, v) };
  const call = await sync._test.odoo();
  const r2 = await afp.stuurMetaLeads([{ lead: lead2, formName: "Fictief | NL | Mitsubishi MSZ-HR", formId: "222", payload: p2, nieuwInOdoo: false }], { store, beschrijving: sync._test.odooBeschrijving(call) });
  assert.equal(r2.verstuurd, 1); assert.ok(opslag.has("meta-" + id2), "onthouden: volgende run niet opnieuw");
  const d2 = await afpGet("/leads/kaarten/" + (await kaartenVan("+32470" + id2.slice(-6)))[0].id);
  naastElkaar("Meta-leadformulier (stond al in Odoo, later naar AFP)", (await odooLead(uit.odoo.leadId)).description, d2.notities);
  const r3 = await afp.stuurMetaLeads([{ lead: lead2, formName: "F", formId: "222", payload: p2, nieuwInOdoo: false }], { store });
  assert.equal(r3.overgeslagen, 1, "tweede run: niets verstuurd");
});

test.after(() => { if (process.env.AFP_TEST_VERGELIJK && VERSLAG.length) require("fs").writeFileSync(process.env.AFP_TEST_VERGELIJK, "# Odoo-beschrijving en AFP-notitie naast elkaar (fictieve testgegevens)\n" + VERSLAG.join("\n") + "\n"); });
