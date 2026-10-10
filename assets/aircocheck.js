/* Smart Cooling Aircocheck v9 — split: geen merken/prijzen naar de klant; monoblock: richtprijs excl. btw */
(function () {
  "use strict";
  var KEY = "sc_aircocheck_v2";
  var root = document.getElementById("ac");
  if (!root) return;
  var PC = window.SC_PC || {};
  var T0 = Date.now();

  var ROOM_TYPES = ["Woonkamer", "Slaapkamer", "Bureau", "Keuken", "Zolderkamer", "Andere"];
  var M2 = [["< 15 m²", 12], ["15–25 m²", 20], ["25–35 m²", 30], ["35–50 m²", 42], ["> 50 m²", 60]];
  var ORI = ["Noord", "Oost", "Zuid", "West", "Weet ik niet"];
  var GLAS = ["Weinig", "Normaal", "Veel"];
  var ISO = ["Goed", "Gemiddeld", "Slecht"];
  var WENSEN = ["Stil", "Design", "Zuivere lucht / allergie", "Laag verbruik", "Bediening via app", "AI-sturing", "Hoogste kwaliteit", "Scherpe prijs"];
  var BEDRIJF = ["Kantoor", "Winkel", "Praktijk", "Horeca", "Serverruimte"];
  var MONO = "Monoblock zonder buitenunit", SPLIT = "Airco met buitenunit";

  // Monoblock-modellen (standaardplaatsing, excl. btw)
  var MM = {
    "25": { n: "Nuova Polar+ 25", kw: "2,5 kW", p: 1350, w: 95, kg: 35, h: "2 × Ø 160 mm + 1 × Ø 32 mm (condens)", lbl: "tot 25 m²", sub: "slaapkamer, bureau" },
    "40": { n: "Nuova Polar Pro 40", kw: "4 kW", p: 1595, w: 100, kg: 48, h: "2 × Ø 200 mm + 1 × Ø 32 mm (condens)", lbl: "25 – 45 m²", sub: "leefruimte, kantoor" }
  };
  var EX = { hoog: 125, beton: 100, kleur: 125, lijnLo: 150, lijnHi: 350 };

  var FLOW = {
    split: ["sys", "waar", "ruimtes", "wens", "contact", "klaar"],
    mono: ["sys", "m1", "m2", "m3", "m4", "m5", "contact", "klaar"]
  };
  var NAMES = { sys: "Systeem", waar: "Waar", ruimtes: "Ruimtes", wens: "Wensen", contact: "Contact", klaar: "Resultaat", m1: "Aantal", m2: "Gevelmuur", m3: "Controles", m4: "Bijzonderheden", m5: "Richtprijs" };

  function blankRoom() { return { type: "", m2: "", ori: "", glas: "", iso: "" }; }
  function blankMono() { return { n: "", sizes: [], ans: { g: "", w: "", b: "", s: "", m: "" }, excl: { g: [], w: [], b: [], m: [] }, hoog: 0, beton: 0, kleur: 0, lijn: "Nee", oud: "Nee" }; }
  var S = {
    step: 1, systeem: "", locatie: "", bedrijf: { type: "", m2: "", pers: "", app: "" },
    n: "", rooms: [], buiten: "", wensen: [], dagdeel: "", mono: blankMono(),
    c: { voornaam: "", naam: "", gsm: "", email: "", straat: "", postcode: "", gemeente: "" },
    sent: false, t0: T0
  };
  var restored = false;
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) { var o = JSON.parse(raw); if (o && !o.sent && o.step > 1 && o.mono) { S = o; restored = true; } }
  } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function clearSave() { try { localStorage.removeItem(KEY); } catch (e) {} }

  function flow() { return S.systeem === MONO ? FLOW.mono : FLOW.split; }
  function cur() { return flow()[S.step - 1]; }
  function isMono() { return S.systeem === MONO; }

  function track(n) {
    var nm = NAMES[flow()[n - 1]] || "";
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: "aircocheck_step", step: n, step_name: nm, route: isMono() ? "monoblock" : "split" });
    if (typeof window.gtag === "function") window.gtag("event", "aircocheck_step", { step: n, step_name: nm, route: isMono() ? "monoblock" : "split" });
  }

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function eur(n) { return "€ " + Number(n).toLocaleString("nl-BE"); }
  function chips(name, opts, val, multi) {
    return '<div class="acc" role="group">' + opts.map(function (o) {
      var on = multi ? val.indexOf(o) > -1 : val === o;
      return '<button type="button" class="ach' + (on ? " on" : "") + '" data-k="' + name + '" data-v="' + esc(o) + '" aria-pressed="' + on + '">' + esc(o) + "</button>";
    }).join("") + "</div>";
  }
  function kw(r) {
    var m = 0; M2.forEach(function (x) { if (x[0] === r.m2) m = x[1]; });
    if (!m) return 0;
    var w = m * 100;
    if (r.ori === "Zuid") w *= 1.15; else if (r.ori === "West") w *= 1.10;
    if (r.glas === "Veel") w *= 1.15;
    if (r.iso === "Slecht") w *= 1.20;
    if (r.type === "Zolderkamer") w *= 1.20;
    return Math.max(2.5, Math.ceil(w / 100) / 10);
  }
  function fmt(k) { return k.toFixed(1).replace(".", ","); }
  function roomsOk() {
    if (!S.rooms.length) return false;
    for (var i = 0; i < S.rooms.length; i++) { var r = S.rooms[i]; if (!r.type || !r.m2 || !r.ori || !r.glas || !r.iso) return false; }
    if (S.rooms.length > 1 && !S.buiten) return false;
    return true;
  }
  function normGsm(v) {
    var d = (v || "").replace(/[^\d+]/g, "");
    if (d.indexOf("+32") === 0) d = "0" + d.slice(3);
    if (d.indexOf("0032") === 0) d = "0" + d.slice(4);
    return d;
  }
  function gsmOk(v) { return /^04\d{8}$/.test(normGsm(v)); }
  function gsmFmt(v) { var d = normGsm(v); return /^04\d{8}$/.test(d) ? d.slice(0, 4) + " " + d.slice(4, 6) + " " + d.slice(6, 8) + " " + d.slice(8) : v; }
  function mailOk(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v || ""); }

  function setRooms(n) {
    var want = n === "4+" ? Math.max(4, S.rooms.length) : parseInt(n, 10);
    while (S.rooms.length < want) S.rooms.push(blankRoom());
    if (n !== "4+") S.rooms = S.rooms.slice(0, want);
    if (S.rooms.length < 2) S.buiten = "";
  }

  // ---------- monoblock helpers ----------
  var M = function () { return S.mono; };
  function units() { return M().sizes.length; }
  function excluded() { var all = []; ["g", "w", "b", "m"].forEach(function (q) { M().excl[q].forEach(function (i) { if (all.indexOf(i) < 0) all.push(i); }); }); return all; }
  function active() { var ex = excluded(), a = []; for (var i = 0; i < units(); i++) if (ex.indexOf(i) < 0) a.push(i); return a; }
  function reason(i) { var e = M().excl; if (e.g.indexOf(i) > -1) return "geen gevelmuur"; if (e.w.indexOf(i) > -1) return "te weinig vrije wand"; if (e.b.indexOf(i) > -1) return "achterkant buiten niet vrij"; if (e.m.indexOf(i) > -1) return "muur niet stevig"; return ""; }
  function setMonoN(n) {
    var want = parseInt(n, 10); M().n = n;
    while (M().sizes.length < want) M().sizes.push("");
    M().sizes = M().sizes.slice(0, want);
    M().excl = { g: [], w: [], b: [], m: [] }; M().ans = { g: "", w: "", b: "", s: "", m: "" };
    M().hoog = M().beton = M().kleur = 0;
  }
  function clampCounts() { var a = active().length; ["hoog", "beton", "kleur"].forEach(function (k) { if (M()[k] > a) M()[k] = a; }); }
  function monoLines() {
    var act = active(), rows = [], tot = 0, m = M();
    act.forEach(function (i) { var mm = MM[m.sizes[i]]; rows.push({ t: "Monoblock " + (i + 1) + ": " + mm.n + " · " + mm.kw + " · standaardplaatsing", p: mm.p }); tot += mm.p; });
    var ex = excluded(); if (ex.length) rows.push({ t: "Monoblock " + ex.map(function (i) { return i + 1; }).join(", ") + ": niet mogelijk (" + ex.map(reason).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ") + "), weggelaten", p: null });
    if (m.hoog) { rows.push({ t: "Speciale buitenkleppen (roosters > 3 m) × " + m.hoog, p: EX.hoog * m.hoog }); tot += EX.hoog * m.hoog; }
    if (m.beton) { rows.push({ t: "Betonboring (betonnen gevel) × " + m.beton, p: EX.beton * m.beton }); tot += EX.beton * m.beton; }
    if (m.kleur) { rows.push({ t: "Speciale roosters zwart / zilver / wit × " + m.kleur, p: EX.kleur * m.kleur }); tot += EX.kleur * m.kleur; }
    if (m.lijn === "Ja") rows.push({ t: "Aparte elektrische lijn met automaat", p: null, txt: eur(EX.lijnLo) + " – " + eur(EX.lijnHi) });
    if (m.oud === "Ja") rows.push({ t: "Oud toestel verwijderen", p: null, txt: "te bekijken" });
    return { rows: rows, tot: tot, act: act };
  }
  function wallSvg(w, h) {
    return '<svg viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Vrije wand: breedte minstens ' + w + ' cm, hoogte minstens 85 cm"><rect width="320" height="175" fill="#F3F6F8" rx="6"/><rect y="175" width="320" height="25" fill="#E3E9EE"/><rect x="60" y="30" width="190" height="125" fill="#E4F3FB" stroke="#46B4E8" stroke-dasharray="5 4" stroke-width="1.5" rx="5"/><rect x="70" y="52" width="170" height="82" rx="7" fill="#fff" stroke="#0A1622" stroke-width="2"/><rect x="80" y="61" width="150" height="9" rx="3" fill="#0A1622" opacity=".85"/><circle cx="125" cy="105" r="14" fill="none" stroke="#E8A23D" stroke-width="1.5" stroke-dasharray="3 3"/><circle cx="185" cy="105" r="14" fill="none" stroke="#E8A23D" stroke-width="1.5" stroke-dasharray="3 3"/><text x="155" y="150" text-anchor="middle" font-family="Inter,sans-serif" font-size="9" fill="#9A5B0E">boringen: ' + esc(h) + '</text><line x1="60" y1="166" x2="250" y2="166" stroke="#1E8FC6" stroke-width="2"/><line x1="60" y1="160" x2="60" y2="172" stroke="#1E8FC6" stroke-width="2"/><line x1="250" y1="160" x2="250" y2="172" stroke="#1E8FC6" stroke-width="2"/><text x="155" y="188" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700" font-size="13" fill="#C2691E">breedte ≥ ' + w + ' cm</text><line x1="265" y1="30" x2="265" y2="155" stroke="#1E8FC6" stroke-width="2"/><line x1="259" y1="30" x2="271" y2="30" stroke="#1E8FC6" stroke-width="2"/><line x1="259" y1="155" x2="271" y2="155" stroke="#1E8FC6" stroke-width="2"/><text x="272" y="88" font-family="Inter,sans-serif" font-weight="700" font-size="11" fill="#C2691E">hoogte</text><text x="272" y="102" font-family="Inter,sans-serif" font-weight="700" font-size="11" fill="#C2691E">≥ 85 cm</text></svg>';
  }
  function yn(q, label, sub, imp) {
    var a = M().ans[q], ex = M().excl[q] || [], hasChips = q !== "s";
    var h = '<div class="acq' + (imp ? " imp" : "") + (a === "Nee" ? " open" : "") + '"><div class="acqt"><div>' + label + (sub ? '<small>' + sub + "</small>" : "") + '</div><div class="acyn"><button type="button" class="' + (a === "Ja" ? "on" : "") + '" data-k="mq.' + q + '" data-v="Ja">Ja</button><button type="button" class="no' + (a === "Nee" ? " on" : "") + '" data-k="mq.' + q + '" data-v="Nee">Nee</button></div></div>';
    if (a === "Nee") {
      h += '<div class="acwhich">';
      if (hasChips) {
        h += '<b>Welke niet?</b><div class="acchips">';
        for (var i = 0; i < units(); i++) h += '<button type="button" class="' + (ex.indexOf(i) > -1 ? "on" : "") + '" data-k="mx.' + q + '" data-v="' + i + '">Monoblock ' + (i + 1) + " · " + MM[M().sizes[i]].kw + "</button>";
        h += "</div>";
        var why = { g: "Een monoblock kan enkel op een gevelmuur. Voor dat toestel is een monoblock dus niet mogelijk.", w: "Zonder voldoende vrije wand past het toestel niet. Voor dat toestel is een monoblock dus niet mogelijk.", b: "De roosters moeten vrij kunnen uitblazen. Voor dat toestel is een monoblock dus niet mogelijk.", m: "Het toestel moet stevig aan de muur hangen. Voor dat toestel is een monoblock dus niet mogelijk." }[q];
        h += '<p class="acmsg">' + why + "</p>";
        if (ex.length && active().length) h += '<p class="acmsg ok">Wilt u toch verder gaan zonder ' + (ex.length === 1 ? "deze monoblock" : "deze monoblocks") + "? De prijs wordt berekend voor de overige " + active().length + ".</p>";
        if (!ex.length) h += '<p class="acmsg">Duid aan welke monoblock(s) niet kunnen.</p>';
      } else {
        h += '<p class="acmsg ok">Geen probleem: wij voorzien een aparte elektrische lijn met automaat. Dit wordt automatisch toegevoegd.</p><span class="acpr">' + eur(EX.lijnLo) + " – " + eur(EX.lijnHi) + " excl. btw, volgens situatie</span>";
      }
      h += "</div>";
    }
    return h + "</div>";
  }
  function stopBox() {
    if (active().length || !excluded().length) return "";
    return '<div class="acq imp acstop"><p class="acmsg stop">Een monoblock is hier niet mogelijk.</p><p class="acmsg">' + (units() === 1 ? "Geen zorgen: een airco met buitenunit kan bijna altijd." : "Geen van de gevraagde monoblocks kan hier geplaatst worden.") + " Wilt u verder gaan met een <b>airco met buitenunit</b>?</p><button type=\"button\" class=\"btn p\" data-split=\"1\">Ja, ga verder met airco met buitenunit →</button></div>";
  }
  function cnt(k, label, sub, price) {
    var a = active().length, v = M()[k], h = '<div class="acq"><div class="acqt"><div>' + label + (sub ? "<small>" + sub + "</small>" : "") + '<span class="acpr">' + price + '</span></div><div class="acyn">';
    for (var i = 0; i <= a; i++) h += '<button type="button" class="' + (i === 0 ? "no" : "") + (v === i ? " on" : "") + '" data-k="mc.' + k + '" data-v="' + i + '">' + i + "</button>";
    return h + "</div></div></div>";
  }

  // ---------- views ----------
  function vSys() {
    return '<h2>Welk systeem zoekt u?</h2><p class="small">Twijfelt u? Kies de standaardoptie, wij bekijken het ter plaatse.</p>' +
      '<div class="acbig">' +
      big("systeem", SPLIT, "Standaardoptie", "De klassieke oplossing: stil binnen, zuinig, voor één of meerdere ruimtes.") +
      big("systeem", MONO, "", "Kies dit als een buitenunit niet mogelijk is via syndicus of verhuurder, of als u een buitenunit niet mooi vindt. Voordeel: geen koelleidingen, geen buitenunit, meestal binnen 1 week geplaatst.") +
      "</div>";
  }
  function big(k, v, tag, txt) {
    var on = S[k] === v;
    return '<button type="button" class="acopt' + (on ? " on" : "") + '" data-k="' + k + '" data-v="' + esc(v) + '" aria-pressed="' + on + '"><b>' + esc(v) + (tag ? ' <em>' + esc(tag) + "</em>" : "") + "</b><span>" + esc(txt) + "</span></button>";
  }
  function vWaar() {
    var h = '<h2>Waar komt de airco?</h2>' + chips("locatie", ["Woning", "Appartement", "Bedrijf"], S.locatie);
    if (S.locatie === "Bedrijf") {
      h += '<div class="acsub"><label class="acl">Type bedrijf</label>' + chips("btype", BEDRIJF, S.bedrijf.type) +
        '<div class="acrow"><label class="acl">Oppervlakte (m²)<input type="number" inputmode="numeric" min="1" data-f="bm2" value="' + esc(S.bedrijf.m2) + '"></label>' +
        '<label class="acl">Aantal personen<input type="number" inputmode="numeric" min="0" data-f="bpers" value="' + esc(S.bedrijf.pers) + '"></label></div>' +
        '<label class="acl">Apparatuur die warmte geeft</label>' + chips("bapp", ["Weinig", "Normaal", "Veel (servers, ovens, verlichting)"], S.bedrijf.app) + "</div>";
    }
    return h;
  }
  function vRuimtes() {
    var h = '<h2>Hoeveel ruimtes wilt u koelen of verwarmen?</h2>' + chips("n", ["1", "2", "3", "4+"], S.n);
    S.rooms.forEach(function (r, i) {
      h += '<fieldset class="acroom"><legend>Ruimte ' + (i + 1) + (S.rooms.length > 4 && i >= 4 ? ' <button type="button" class="acdel" data-del="' + i + '" aria-label="Ruimte verwijderen">verwijderen</button>' : "") + "</legend>" +
        '<label class="acl">Type</label>' + chips("r" + i + ".type", ROOM_TYPES, r.type) +
        '<label class="acl">Oppervlakte</label>' + chips("r" + i + ".m2", M2.map(function (x) { return x[0]; }), r.m2) +
        '<label class="acl">Grootste raam kijkt naar</label>' + chips("r" + i + ".ori", ORI, r.ori) +
        '<label class="acl">Hoeveel glas?</label>' + chips("r" + i + ".glas", GLAS, r.glas) +
        '<label class="acl">Isolatie</label>' + chips("r" + i + ".iso", ISO, r.iso) + "</fieldset>";
    });
    if (S.n === "4+" && S.rooms.length < 8) h += '<button type="button" class="btn s" data-add="1">+ Ruimte toevoegen</button>';
    if (S.rooms.length > 1) {
      h += '<div class="acsub"><label class="acl">Hoeveel buitenunits?</label>' + chips("buiten", ["1", "2", "3", "4", "Adviseer mij"], S.buiten) +
        '<p class="small">Eén buitenunit voor meerdere ruimtes heet een multisplit: minder aan de gevel, vaak voordeliger.</p></div>';
    }
    return h;
  }
  function vWens() {
    return '<h2>Wat vindt u belangrijk?</h2><p class="small">Kies zoveel als u wilt.</p>' + chips("wensen", WENSEN, S.wensen, true) +
      '<p class="acnote">Hoe meer wensen u aanvinkt, hoe hoger de prijs kan uitvallen. Wij zoeken altijd de beste balans.</p>';
  }
  // --- monoblock ---
  function vM1() {
    var m = M(), h = '<h2>Hoeveel monoblocks wenst u?</h2><p class="small">Eén toestel per ruimte. Kies daarna per toestel de grootte van de ruimte.</p>' + chips("mn", ["1", "2", "3", "4", "5"], m.n);
    m.sizes.forEach(function (s, i) {
      h += '<fieldset class="acroom"><legend>Monoblock ' + (i + 1) + " — grootte van de ruimte</legend><div class=\"acc\">";
      ["25", "40"].forEach(function (k) {
        h += '<button type="button" class="ach acsz' + (s === k ? " on" : "") + '" data-k="ms.' + i + '" data-v="' + k + '">' + MM[k].lbl + "<small>" + MM[k].sub + "</small></button>";
      });
      h += "</div></fieldset>";
    });
    if (m.sizes.length && m.sizes.every(Boolean)) {
      var tot = 0;
      h += '<div class="acmodel"><small>Ons advies</small>';
      m.sizes.forEach(function (s, i) { tot += MM[s].p; h += "<div><span>Monoblock " + (i + 1) + ": <b>" + MM[s].n + "</b> · " + MM[s].kw + "</span><span>" + eur(MM[s].p) + "</span></div>"; });
      h += '<div class="tot"><span>Standaardplaatsing, excl. btw</span><b>' + eur(tot) + "</b></div></div>";
    }
    return h;
  }
  function vM2() {
    var m = M(), g25 = [], g40 = [];
    m.sizes.forEach(function (s, i) { (s === "40" ? g40 : g25).push(i + 1); });
    var h = '<h2>Kunnen alle gevraagde monoblocks op een gevelmuur komen?</h2><p class="small">Het toestel hangt aan de binnenkant van een buitengevel. Zo veel vrije wand hebt u nodig:</p><div class="acdraw' + (g25.length && g40.length ? " two" : "") + '">';
    if (g25.length) h += '<div class="acd"><h4>Monoblock ' + g25.join(", ") + " — 2,5 kW</h4>" + wallSvg(95, MM["25"].h) + "</div>";
    if (g40.length) h += '<div class="acd"><h4>Monoblock ' + g40.join(", ") + " — 4 kW</h4>" + wallSvg(100, MM["40"].h) + "</div>";
    h += "</div>";
    var wq = g25.length && g40.length ? "2,5 kW: ≥ 95 cm breed · 4 kW: ≥ 100 cm breed · hoogte ≥ 85 cm" : (g40.length ? "breedte ≥ 100 cm en hoogte ≥ 85 cm" : "breedte ≥ 95 cm en hoogte ≥ 85 cm");
    h += yn("g", "Alle gevraagde monoblocks kunnen op een <b>gevelmuur</b>", "", true);
    h += yn("w", "Er is overal voldoende <b>vrije wand</b>", wq, true);
    return h + stopBox();
  }
  function vM3() {
    var big = M().sizes.indexOf("40") > -1;
    var h = '<h2>Nog drie controles</h2><p class="small">Geldt voor elke plaats waar een monoblock komt.</p>';
    h += yn("b", "De <b>achterkant buiten is vrij</b>", "Er hangt of staat niets op de plaats van de boringen.", true);
    h += yn("s", "<b>Stopcontact binnen 5 m</b>", "Zonder zware verbruiker op dezelfde lijn.", true);
    h += yn("m", "De muur is <b>stevig</b>", "Een toestel weegt " + (big ? "tot 48" : "35") + " kg.", true);
    return h + stopBox();
  }
  function vM4() {
    var m = M(), forced = m.ans.s === "Nee";
    var h = '<h2>Bijzonderheden</h2><p class="small">Per toestel, zo klopt de prijs meteen. Alle prijzen excl. btw.</p>';
    h += cnt("hoog", "Roosters <b>hoger dan 3 m</b> boven de grond", "Dan plaatsen wij speciale buitenkleppen.", eur(EX.hoog) + " per toestel");
    h += cnt("beton", "De gevel is in <b>beton</b>", "Enkel dan rekenen wij een betonboring aan.", eur(EX.beton) + " per toestel");
    h += cnt("kleur", "<b>Speciale roosters</b> in zwart, zilver of wit", "Standaard roosters zijn inbegrepen.", eur(EX.kleur) + " per toestel");
    h += '<div class="acq' + (forced ? " dim" : "") + '"><div class="acqt"><div><b>Aparte elektrische lijn</b> met automaat gewenst<small>' + (forced ? "Automatisch toegevoegd: geen geschikt stopcontact binnen 5 m." : "Als er geen geschikt stopcontact is.") + '</small><span class="acpr">' + eur(EX.lijnLo) + " – " + eur(EX.lijnHi) + ', volgens situatie</span></div><div class="acyn"><button type="button" class="' + (m.lijn === "Ja" ? "on" : "") + '" data-k="mc.lijn" data-v="Ja"' + (forced ? " disabled" : "") + '>Ja</button><button type="button" class="no' + (m.lijn === "Nee" ? " on" : "") + '" data-k="mc.lijn" data-v="Nee"' + (forced ? " disabled" : "") + '>Nee</button></div></div></div>';
    h += '<div class="acq"><div class="acqt"><div><b>Oud toestel</b> verwijderen<span class="acpr">te bekijken bij het plaatsbezoek</span></div><div class="acyn"><button type="button" class="' + (m.oud === "Ja" ? "on" : "") + '" data-k="mc.oud" data-v="Ja">Ja</button><button type="button" class="no' + (m.oud === "Nee" ? " on" : "") + '" data-k="mc.oud" data-v="Nee">Nee</button></div></div></div>';
    return h;
  }
  function vM5() {
    var L = monoLines();
    var h = '<h2>Uw richtprijs</h2><p class="small">Standaardplaatsing per toestel: boringen, condensafvoer, standaard roosters, aansluiting op het stopcontact, testen en uitleg. Diamantboring droog met stofafzuiging.</p><table class="actbl">';
    L.rows.forEach(function (r) { h += "<tr><td>" + esc(r.t) + "</td><td>" + (r.p == null ? (r.txt || "—") : eur(r.p)) + "</td></tr>"; });
    h += '<tr class="tot"><td>Richtprijs excl. btw (' + L.act.length + " toestel" + (L.act.length > 1 ? "len" : "") + ")</td><td>" + eur(L.tot) + "</td></tr></table>";
    h += '<p class="acnote">Alle prijzen <b>excl. btw</b> · 6 % btw voor particulieren, 21 % voor bedrijven. Definitieve prijs na gratis plaatsbezoek. Meestal <b>binnen 1 week geplaatst</b>.</p>';
    return h;
  }
  function inp(f, label, type, ac, extra) {
    return '<label class="acl">' + label + ' *<input required type="' + type + '" data-f="' + f + '" autocomplete="' + ac + '" value="' + esc(S.c[f]) + '"' + (extra || "") + '><small class="acerr" data-e="' + f + '"></small></label>';
  }
  function vContact() {
    return '<h2>Uw contactgegevens</h2><p class="small">Wanneer bereiken wij u het best?</p>' +
      chips("dagdeel", ["Voormiddag", "Namiddag", "Avond", "Maakt niet uit"], S.dagdeel) +
      '<div class="acrow">' + inp("voornaam", "Voornaam", "text", "given-name") + inp("naam", "Naam", "text", "family-name") + "</div>" +
      '<div class="acrow">' + inp("gsm", "Gsm", "tel", "tel", ' inputmode="tel" placeholder="04xx xx xx xx"') + inp("email", "E-mail", "email", "email") + "</div>" +
      inp("straat", "Straat en nr", "text", "street-address") +
      '<div class="acrow">' + inp("postcode", "Postcode", "text", "postal-code", ' inputmode="numeric" maxlength="4"') + inp("gemeente", "Gemeente", "text", "address-level2") + "</div>" +
      '<p class="small acpriv">Door te verzenden gaat u akkoord met ons <a href="/privacy/">privacybeleid</a>. Uw gegevens gebruiken wij enkel voor uw offerte.</p>' +
      '<p class="acerr" id="acsenderr"></p>';
  }
  function vKlaar() {
    if (isMono()) {
      var L = monoLines();
      return '<div class="acdone"><h2>Bedankt, ' + esc(S.c.voornaam) + '!</h2>' +
        '<p class="lead">Uw offerte voor ' + L.act.length + " monoblock" + (L.act.length > 1 ? "s" : "") + " (richtprijs <b>" + eur(L.tot) + "</b> excl. btw) komt nu in uw mailbox.</p>" +
        '<h3>Zo gaat het verder</h3><ul class="acnext"><li><b>Uw aanvraag is goed ontvangen.</b> U ontvangt uw offerte per e-mail.</li><li><b>Wij bellen u binnen 1 werkdag</b> om het gratis plaatsbezoek in te plannen (' + esc(S.dagdeel.toLowerCase()) + ').</li><li><b>Stuur ons ondertussen een paar foto\'s</b>: de muur binnen waar het toestel komt en dezelfde muur langs buiten. Via WhatsApp of als antwoord op onze mail.</li><li><b>Wij bevestigen uw prijs</b> na het plaatsbezoek. Meestal binnen 1 week geplaatst.</li></ul>' +
        '<p><a href="https://wa.me/32470961121" class="btn p" target="_blank" rel="noopener">Foto\'s sturen via WhatsApp</a></p>' +
        '<p class="small">Uw prijs ligt altijd vast vóór de plaatsing. Na de installatie komen er nooit extra kosten.</p>' +
        '<p><a href="/monoblock-airco/" class="btn s">Meer over de Nuova Polar monoblock</a></p></div>';
    }
    var rows = S.rooms.map(function (r, i) {
      return '<li><span>Ruimte ' + (i + 1) + ": " + esc(r.type) + " (" + esc(r.m2) + ")</span><b>± " + fmt(kw(r)) + " kW</b></li>";
    }).join("");
    return '<div class="acdone"><h2>Bedankt, ' + esc(S.c.voornaam) + '!</h2>' +
      '<p class="lead">Dit is onze eerste inschatting van het vermogen per ruimte:</p><ul class="ackw">' + rows + "</ul>" +
      '<h3>Zo gaat het verder</h3><ul class="acnext"><li><b>Uw aanvraag is goed ontvangen.</b> Uw persoonlijk adviesrapport komt nu in uw mailbox.</li><li><b>Binnen 3 dagen streven wij ernaar u uw richtprijs te sturen</b>, op basis van uw Aircocheck.</li><li><b>Stuur ons ondertussen een paar foto\'s</b>: de plaats van de binnenunit, de buitenunit en het stopcontact in de buurt. Via WhatsApp of als antwoord op onze mail.</li><li><b>Wij bevestigen uw prijs</b> via uw foto\'s, een aangepaste offerte of een gratis plaatsbezoek.</li><li><b>U beslist, wij plaatsen.</b></li></ul>' +
      '<p><a href="https://wa.me/32470961121" class="btn p" target="_blank" rel="noopener">Foto\'s sturen via WhatsApp</a></p>' +
      '<p class="small">Uw prijs ligt altijd vast vóór de plaatsing. Na de installatie komen er nooit extra kosten.</p>' +
      '<p><a href="/toestellen/" class="btn s">Bekijk onze toestellen</a></p></div>';
  }
  var VIEWS = { sys: vSys, waar: vWaar, ruimtes: vRuimtes, wens: vWens, contact: vContact, klaar: vKlaar, m1: vM1, m2: vM2, m3: vM3, m4: vM4, m5: vM5 };

  function ynOk(q) { var a = M().ans[q]; if (a === "Ja") return true; if (a === "Nee") return q === "s" || M().excl[q].length > 0; return false; }
  function valid(k) {
    if (k === "sys") return !!S.systeem;
    if (k === "waar") return !!S.locatie && (S.locatie !== "Bedrijf" || !!S.bedrijf.type);
    if (k === "ruimtes") return roomsOk();
    if (k === "wens") return true;
    if (k === "m1") return M().sizes.length > 0 && M().sizes.every(Boolean);
    if (k === "m2") return ynOk("g") && ynOk("w") && active().length > 0;
    if (k === "m3") return ynOk("b") && ynOk("s") && ynOk("m") && active().length > 0;
    if (k === "m4" || k === "m5") return active().length > 0;
    if (k === "contact") return !!S.dagdeel && S.c.voornaam && S.c.naam && gsmOk(S.c.gsm) && mailOk(S.c.email) && S.c.straat && /^\d{4}$/.test(S.c.postcode) && S.c.gemeente;
    return true;
  }
  function hint(k) {
    if (k === "sys") return "Kies een systeem.";
    if (k === "waar") return S.locatie === "Bedrijf" ? "Kies het type bedrijf." : "Kies waar de airco komt.";
    if (k === "ruimtes") return !S.n ? "Kies het aantal ruimtes." : (S.rooms.length > 1 && !S.buiten ? "Kies het aantal buitenunits." : "Vul elke ruimte volledig in.");
    if (k === "m1") return !M().n ? "Kies het aantal monoblocks." : "Kies voor elke monoblock de grootte van de ruimte.";
    if (k === "m2" || k === "m3") return active().length ? "Beantwoord elke vraag met Ja of Nee (bij Nee: duid aan welke)." : "";
    if (k === "contact") return "Vul alle velden correct in en kies een dagdeel.";
    return "";
  }

  function render() {
    var f = flow(), k = cur(), N = f.length, n = S.step, view = VIEWS[k]();
    var last = k === "klaar", pct = Math.round(((n - 1) / (N - 1)) * 100);
    var nextTxt = k === "contact" ? (isMono() ? "Verstuur en ontvang offerte" : "Verstuur en bekijk resultaat") : k === "m4" ? "Bereken richtprijs" : "Volgende";
    var hideNext = (k === "m2" || k === "m3") && !active().length && excluded().length > 0;
    root.innerHTML =
      (restored && !last ? '<p class="acresume">Welkom terug, u gaat verder waar u was. <button type="button" data-reset="1">Opnieuw beginnen</button></p>' : "") +
      '<div class="acprog" aria-hidden="true"><i style="width:' + pct + '%"></i></div>' +
      '<p class="acstep">Stap ' + n + " van " + N + " · " + NAMES[k] + "</p>" +
      '<div class="acbody">' + view + "</div>" +
      (!last ? '<div class="acnav">' + (n > 1 ? '<button type="button" class="btn s" data-back="1">Terug</button>' : "<span></span>") +
        (hideNext ? "<span></span>" : '<button type="button" class="btn p lg" data-next="1"' + (valid(k) ? "" : ' aria-disabled="true"') + ">" + nextTxt + "</button>") + "</div>" +
        '<p class="achint" aria-live="polite"></p>' : "");
    if (k === "contact" || k === "waar") wireInputs();
  }

  function wireInputs() {
    root.querySelectorAll("input[data-f]").forEach(function (el) {
      el.addEventListener("input", function () {
        var f = el.dataset.f;
        if (f === "bm2") S.bedrijf.m2 = el.value; else if (f === "bpers") S.bedrijf.pers = el.value; else S.c[f] = el.value.trim();
        if (f === "postcode" && /^\d{4}$/.test(el.value) && PC[el.value] && !S.c.gemeente) {
          S.c.gemeente = PC[el.value]; var g = root.querySelector('input[data-f="gemeente"]'); if (g) g.value = S.c.gemeente;
        }
        save(); refreshNext();
      });
      el.addEventListener("blur", function () {
        var f = el.dataset.f, e = root.querySelector('[data-e="' + f + '"]'); if (!e) return;
        var msg = "";
        if (f === "gsm") { if (el.value && !gsmOk(el.value)) msg = "Geef een Belgisch gsm-nummer (04xx xx xx xx)."; else if (el.value) { el.value = gsmFmt(el.value); S.c.gsm = el.value; } }
        if (f === "email" && el.value && !mailOk(el.value)) msg = "Dit e-mailadres lijkt niet juist.";
        if (f === "postcode" && el.value && !/^\d{4}$/.test(el.value)) msg = "Postcode heeft 4 cijfers.";
        e.textContent = msg; save(); refreshNext();
      });
    });
  }
  function refreshNext() {
    var b = root.querySelector("[data-next]"); if (!b) return;
    if (valid(cur())) b.removeAttribute("aria-disabled"); else b.setAttribute("aria-disabled", "true");
  }

  function setVal(k, v) {
    if (k === "systeem") { S.systeem = v; if (v === MONO) S.buiten = ""; }
    else if (k === "locatie") S.locatie = v;
    else if (k === "btype") S.bedrijf.type = v;
    else if (k === "bapp") S.bedrijf.app = v;
    else if (k === "n") { S.n = v; setRooms(v); }
    else if (k === "buiten") S.buiten = v;
    else if (k === "dagdeel") S.dagdeel = v;
    else if (k === "wensen") { var i = S.wensen.indexOf(v); if (i > -1) S.wensen.splice(i, 1); else S.wensen.push(v); }
    else if (k === "mn") setMonoN(v);
    else if (k.indexOf("ms.") === 0) M().sizes[+k.slice(3)] = v;
    else if (k.indexOf("mq.") === 0) { var q = k.slice(3); M().ans[q] = v; if (v === "Ja" && M().excl[q]) M().excl[q] = []; if (q === "s") M().lijn = v === "Nee" ? "Ja" : M().lijn; clampCounts(); }
    else if (k.indexOf("mx.") === 0) { var q2 = k.slice(3), arr = M().excl[q2], idx = arr.indexOf(+v); if (idx > -1) arr.splice(idx, 1); else arr.push(+v); clampCounts(); }
    else if (k.indexOf("mc.") === 0) { var c = k.slice(3); M()[c] = (c === "lijn" || c === "oud") ? v : +v; }
    else if (k.charAt(0) === "r") { var p = k.slice(1).split("."); S.rooms[+p[0]][p[1]] = v; }
  }

  function payload() {
    var mob = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    var d = {
      "form-name": "aircocheck", "bot-field": "",
      systeem: S.systeem, locatie: S.locatie,
      bedrijf_type: S.bedrijf.type, bedrijf_m2: S.bedrijf.m2, bedrijf_personen: S.bedrijf.pers, bedrijf_apparatuur: S.bedrijf.app,
      wensen: S.wensen.join(", "), dagdeel: S.dagdeel,
      voornaam: S.c.voornaam, naam: S.c.naam, gsm: gsmFmt(S.c.gsm), email: S.c.email,
      straat: S.c.straat, postcode: S.c.postcode, gemeente: S.c.gemeente,
      bron_pagina: document.referrer ? (function () { try { return new URL(document.referrer).pathname; } catch (e) { return document.referrer; } })() : "direct",
      landingspagina: (function () { try { return sessionStorage.getItem("sc_land") || location.pathname; } catch (e) { return location.pathname; } })(),
      apparaat: mob ? "mobiel" : "desktop",
      duur_sec: String(Math.round((Date.now() - (S.t0 || T0)) / 1000)),
      mono_json: "", mono_prijs: "", mono_extras: "", mono_checks: ""
    };
    if (isMono()) {
      var m = M(), L = monoLines(), ex = excluded();
      var unitsArr = m.sizes.map(function (s, i) { var mm = MM[s]; return { nr: i + 1, m2: mm.lbl, model: mm.n, kw: mm.kw, prijs: mm.p, actief: ex.indexOf(i) < 0, reden: reason(i) }; });
      d.aantal_ruimtes = String(L.act.length);
      d.ruimtes = unitsArr.map(function (u) { return "Monoblock " + u.nr + ": " + u.model + " (" + u.m2 + ") → " + u.kw + (u.actief ? "" : " — NIET MOGELIJK: " + u.reden); }).join(" | ");
      d.ruimtes_json = JSON.stringify(unitsArr.filter(function (u) { return u.actief; }).map(function (u) { return { type: "Monoblock " + u.nr + " – " + u.model, m2: u.m2, kw: parseFloat(u.kw.replace(",", ".")) }; }));
      d.kw_totaal = fmt(unitsArr.filter(function (u) { return u.actief; }).reduce(function (a, u) { return a + parseFloat(u.kw.replace(",", ".")); }, 0));
      d.buitenunits = "0";
      d.mono_json = JSON.stringify({ units: unitsArr, hoog: m.hoog, beton: m.beton, kleur: m.kleur, lijn: m.lijn, lijn_auto: m.ans.s === "Nee", oud: m.oud, totaal_excl: L.tot, lines: L.rows.map(function (r) { return { t: r.t, p: r.p, txt: r.txt || "" }; }) });
      d.mono_prijs = String(L.tot);
      d.mono_extras = L.rows.filter(function (r) { return /^(Speciale|Betonboring|Aparte|Oud)/.test(r.t); }).map(function (r) { return r.t + (r.p != null ? " = " + eur(r.p) : r.txt ? " = " + r.txt : ""); }).join(" | ") || "geen";
      d.mono_checks = ["g:gevelmuur", "w:vrije wand", "b:achterkant buiten vrij", "s:stopcontact ≤ 5 m", "m:stevige muur"].map(function (x) { var q = x.split(":")[0]; return x.split(":")[1] + " = " + (m.ans[q] || "-") + (m.excl[q] && m.excl[q].length ? " (niet: " + m.excl[q].map(function (i) { return i + 1; }).join(", ") + ")" : ""); }).join(" | ");
    } else {
      var kws = S.rooms.map(kw), tot = kws.reduce(function (a, b) { return a + b; }, 0);
      d.aantal_ruimtes = String(S.rooms.length);
      d.ruimtes = S.rooms.map(function (r, i) { return "Ruimte " + (i + 1) + ": " + r.type + ", " + r.m2 + ", " + r.ori + ", glas " + r.glas.toLowerCase() + ", isolatie " + r.iso.toLowerCase() + " → ± " + fmt(kws[i]) + " kW"; }).join(" | ");
      d.ruimtes_json = JSON.stringify(S.rooms.map(function (r, i) { return { type: r.type, m2: r.m2, ori: r.ori, glas: r.glas, iso: r.iso, kw: kws[i] }; }));
      d.kw_totaal = fmt(tot); d.buitenunits = S.buiten || (S.rooms.length === 1 ? "1" : "");
    }
    return d;
  }

  function send() {
    var btn = root.querySelector("[data-next]"); if (btn) { btn.setAttribute("aria-disabled", "true"); btn.textContent = "Bezig met verzenden…"; }
    var body = new URLSearchParams(payload()).toString();
    fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body })
      .then(function (r) { if (!r.ok) throw new Error(r.status); S.sent = true; S.step = flow().length; clearSave(); render(); track(S.step); window.scrollTo(0, root.offsetTop - 90); })
      .catch(function () {
        var e = document.getElementById("acsenderr");
        if (e) e.innerHTML = 'Verzenden lukte niet. Probeer opnieuw, of <a href="' + (window.SC_WA || "#") + '" target="_blank" rel="noopener">stuur ons een WhatsApp</a>.';
        if (btn) { btn.removeAttribute("aria-disabled"); btn.textContent = isMono() ? "Verstuur en ontvang offerte" : "Verstuur en bekijk resultaat"; }
      });
  }

  root.addEventListener("click", function (ev) {
    var t = ev.target.closest("button"); if (!t || !root.contains(t) || t.disabled) return;
    if (t.dataset.reset) { clearSave(); location.reload(); return; }
    if (t.dataset.split) { S.systeem = SPLIT; S.mono = blankMono(); S.step = 2; save(); render(); track(S.step); window.scrollTo(0, root.offsetTop - 90); return; }
    if (t.dataset.k) { setVal(t.dataset.k, t.dataset.v); save(); render(); return; }
    if (t.dataset.add) { if (S.rooms.length < 8) S.rooms.push(blankRoom()); save(); render(); return; }
    if (t.dataset.del) { S.rooms.splice(+t.dataset.del, 1); save(); render(); return; }
    if (t.dataset.back) { S.step = Math.max(1, S.step - 1); save(); render(); track(S.step); window.scrollTo(0, root.offsetTop - 90); return; }
    if (t.dataset.next) {
      var k = cur();
      if (!valid(k)) { var h = root.querySelector(".achint"); if (h) h.textContent = hint(k); return; }
      if (k === "contact") { send(); return; }
      S.step += 1; save(); render(); track(S.step); window.scrollTo(0, root.offsetTop - 90);
    }
  });

  render(); track(S.step);
})();
