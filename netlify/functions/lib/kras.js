// netlify/functions/lib/kras.js  (v3, 14/11/2026) — gedeelde logica kraskaart-actie
// v3 (Ekrem 14/11): EERST gegevens (kras-start) -> dan krassen -> aantal airco's / m² / merk (kras-finish).
//     Bedragen vanaf € 75. Deelname telt al bij stap 1 (gegevens), zodat we elke deelnemer kunnen bellen.
// Flow: /kras/ krassen (kras-reveal geeft bedrag + ondertekend token) -> Aircocheck (airco met buitenunit)
//       -> bij verzenden: processLead verifieert het token, ontdubbelt (e-mail/gsm), maakt een INTERNE code,
//          telt de deelnemer en zet bedrag + code in Odoo (x_kras_korting / x_kras_code / x_kras_nummer).
// De klant ziet enkel het bedrag, nooit de code.
const crypto = require("crypto");

const END = () => process.env.KRAS_END || "2026-12-31";
const SALT = () => process.env.KRAS_SALT || crypto.createHash("sha256").update("kras:" + (process.env.ODOO_API_KEY || "sc")).digest("hex");
const TOKEN_DAYS = 7;
const REEKS = [75, 75, 75, 75, 75, 100, 100, 100, 125, 125, 150];   // per 11 deelnemers (Ekrem 14/11, was 5×50/3×75/1×100/1×125/1×150)
const OUD = [50, 75, 100, 125, 150];                                  // bedragen in oude tokens (v2) blijven geldig

const hmac = (s) => crypto.createHmac("sha256", SALT()).update(String(s)).digest("base64url");
const h32 = (s) => crypto.createHmac("sha256", SALT()).update(String(s)).digest("hex").slice(0, 32);

function seededShuffle(arr, seed) {
  const a = arr.slice();
  let x = parseInt(crypto.createHmac("sha256", SALT()).update("cycle:" + seed).digest("hex").slice(0, 8), 16) || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function amountFor(n) { const i = Math.max(0, n - 1), k = Math.floor(i / REEKS.length); return seededShuffle(REEKS, "r11:" + k)[i % REEKS.length]; }

function actieLoopt(now = new Date()) { return now <= new Date(END() + "T23:59:59+01:00"); }
function geldigTot() { const [y, m, d] = END().split("-"); return `${d}/${m}/${y}`; }

// token = base64url(JSON{a,n,exp}) + "." + hmac
function makeToken(a) {
  const p = Buffer.from(JSON.stringify({ a, n: crypto.randomBytes(6).toString("hex"), exp: Date.now() + TOKEN_DAYS * 864e5 })).toString("base64url");
  return p + "." + hmac(p);
}
function readToken(tok) {
  if (!tok || typeof tok !== "string" || tok.indexOf(".") < 0) return null;
  const [p, sig] = tok.split(".");
  if (!p || !sig || hmac(p) !== sig) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); if (!o || !OUD.includes(o.a) || !(o.exp > Date.now())) return null; return o; } catch (e) { return null; }
}
function makeCode(amount) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.randomBytes(4); let s = "";
  for (let i = 0; i < 4; i++) s += abc[b[i] % abc.length];
  return `SC-${s}-${amount}`;
}
function normGsm(g) {
  let d = String(g || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+32")) d = "0" + d.slice(3); else if (d.startsWith("0032")) d = "0" + d.slice(4);
  return /^04\d{8}$/.test(d) ? d : null;
}
async function countClaims(store) { const { blobs } = await store.list({ prefix: "c/" }); return blobs.length; }

// Volgende bedrag tonen (deterministisch op de teller: herladen geeft hetzelfde bedrag)
async function reveal(store) { const n = await countClaims(store); const a = amountFor(n + 1); return { a, token: makeToken(a) }; }

// Deelname vastleggen (idempotent per e-mail en gsm). Geeft {korting, code, nummer, nieuw} of {fout}
async function claim(store, tok, email, gsm) {
  const t = readToken(tok); if (!t) return { fout: "token ongeldig of verlopen" };
  if (!actieLoopt()) return { fout: "actie afgelopen" };
  const kE = email ? "e/" + h32(String(email).trim().toLowerCase()) : null, g = normGsm(gsm), kP = g ? "p/" + h32(g) : null;
  const [oE, oP] = await Promise.all([kE ? store.get(kE, { type: "json" }) : null, kP ? store.get(kP, { type: "json" }) : null]);
  const oud = oE || oP; if (oud) return Object.assign({ nieuw: false }, oud);
  const ts = Date.now().toString().padStart(14, "0") + "-" + crypto.randomBytes(3).toString("hex");
  await store.setJSON("c/" + ts, { t: Date.now(), a: t.a });
  const { blobs } = await store.list({ prefix: "c/" });
  const nummer = blobs.map((x) => x.key).sort().indexOf("c/" + ts) + 1 || blobs.length;
  const rec = { korting: t.a, code: makeCode(t.a), nummer, geldig_tot: geldigTot(), t: new Date().toISOString() };
  const writes = [store.setJSON("r/" + rec.code, rec)]; if (kE) writes.push(store.setJSON(kE, rec)); if (kP) writes.push(store.setJSON(kP, rec));
  await Promise.all(writes);
  return Object.assign({ nieuw: true }, rec);
}

// v3: deelname vastleggen op basis van gegevens (zonder token). Idempotent per e-mail én gsm.
// Bedrag = volgende uit het schema op basis van het deelnemersnummer. Geeft {korting, code, nummer, nieuw} of {fout}.
async function claimDirect(store, email, gsm) {
  if (!actieLoopt()) return { fout: "actie afgelopen" };
  const kE = email ? "e/" + h32(String(email).trim().toLowerCase()) : null, g = normGsm(gsm), kP = g ? "p/" + h32(g) : null;
  const [oE, oP] = await Promise.all([kE ? store.get(kE, { type: "json" }) : null, kP ? store.get(kP, { type: "json" }) : null]);
  const oud = oE || oP; if (oud) return Object.assign({ nieuw: false }, oud);
  const ts = Date.now().toString().padStart(14, "0") + "-" + crypto.randomBytes(3).toString("hex");
  await store.setJSON("c/" + ts, { t: Date.now(), a: 0 });
  const { blobs } = await store.list({ prefix: "c/" });
  const nummer = blobs.map((x) => x.key).sort().indexOf("c/" + ts) + 1 || blobs.length;
  const a = amountFor(nummer);
  await store.setJSON("c/" + ts, { t: Date.now(), a });
  const rec = { korting: a, code: makeCode(a), nummer, geldig_tot: geldigTot(), t: new Date().toISOString() };
  const writes = [store.setJSON("r/" + rec.code, rec)]; if (kE) writes.push(store.setJSON(kE, rec)); if (kP) writes.push(store.setJSON(kP, rec));
  await Promise.all(writes);
  return Object.assign({ nieuw: true }, rec);
}
// Sessie-token voor stap 2 (kras-finish): verwijst naar de deelname zonder de interne code te tonen.
function makeSessie(code) {
  const p = Buffer.from(JSON.stringify({ r: h32("sess:" + code).slice(0, 16), exp: Date.now() + 14 * 864e5 })).toString("base64url");
  return p + "." + hmac(p);
}
function readSessie(tok) {
  if (!tok || typeof tok !== "string" || tok.indexOf(".") < 0) return null;
  const [p, sig] = tok.split("."); if (!p || !sig || hmac(p) !== sig) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o && o.r && o.exp > Date.now() ? o : null; } catch (e) { return null; }
}
async function saveSessie(store, code, klant) { const tok = makeSessie(code); const o = readSessie(tok); await store.setJSON("s/" + o.r, { code, klant: klant || null }); return tok; }
async function recordFromSessie(store, tok) {
  const o = readSessie(tok); if (!o) return null;
  const s = await store.get("s/" + o.r, { type: "json" }); if (!s || !s.code) return null;
  const r = await store.get("r/" + s.code, { type: "json" });
  return r ? Object.assign({}, r, { klant: s.klant || {} }) : null;
}

const VOORWAARDEN_KORT = "Enkel airco met buitenunit (niet voor monoblock). De gewonnen korting geldt volledig bij een offerte boven € 2.000 (excl. btw, vóór korting). Bij een lagere offerte krijgt u nu: t/m € 1.500 € 50 · t/m € 1.750 € 75 · t/m € 2.000 € 100, en het verschil als tegoed op uw eerste jaarlijkse onderhoud door Smart Cooling (geldig t/m 31/12/2027). Geldig voor offertes aangevraagd t/m 31/12/2026, 1 per persoon/adres, niet cumuleerbaar, niet inwisselbaar voor geld. Volledige voorwaarden: smartcooling.be/kras";
const TEGOED_TOT = "31/12/2027";

module.exports = { amountFor, reveal, claim, claimDirect, saveSessie, recordFromSessie, readToken, makeToken, geldigTot, actieLoopt, normGsm, VOORWAARDEN_KORT, TEGOED_TOT, REEKS };
