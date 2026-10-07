/* Smart Cooling Aircocheck v8 — geen merken of prijzen per toestel naar de klant */
(function () {
  "use strict";
  var KEY = "sc_aircocheck_v1";
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
  var STEPS = ["Systeem", "Waar", "Ruimtes", "Wensen", "Contact", "Resultaat"];

  function blankRoom() { return { type: "", m2: "", ori: "", glas: "", iso: "" }; }
  var S = {
    step: 1, systeem: "", locatie: "", bedrijf: { type: "", m2: "", pers: "", app: "" },
    n: "", rooms: [], buiten: "", wensen: [], dagdeel: "",
    c: { voornaam: "", naam: "", gsm: "", email: "", straat: "", postcode: "", gemeente: "" },
    sent: false, t0: T0
  };
  var restored = false;
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) { var o = JSON.parse(raw); if (o && !o.sent && o.step > 1) { S = o; restored = true; } }
  } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function clearSave() { try { localStorage.removeItem(KEY); } catch (e) {} }

  function track(n) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: "aircocheck_step", step: n, step_name: STEPS[n - 1] });
    if (typeof window.gtag === "function") window.gtag("event", "aircocheck_step", { step: n, step_name: STEPS[n - 1] });
  }

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
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
    if (S.systeem !== "Monoblock zonder buitenunit" && S.rooms.length > 1 && !S.buiten) return false;
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

  // ---------- views ----------
  function vStep1() {
    return '<h2>Welk systeem zoekt u?</h2><p class="small">Twijfelt u? Kies de standaardoptie, wij bekijken het ter plaatse.</p>' +
      '<div class="acbig">' +
      big("systeem", "Airco met buitenunit", "Standaardoptie", "De klassieke oplossing: stil binnen, zuinig, voor één of meerdere ruimtes.") +
      big("systeem", "Monoblock zonder buitenunit", "", "Kies dit als een buitenunit niet mogelijk is via syndicus of verhuurder, of als u een buitenunit niet mooi vindt. Voordeel: geen koelleidingen, geen buitenunit, meestal binnen 1 week geplaatst.") +
      "</div>";
  }
  function big(k, v, tag, txt) {
    var on = S[k] === v;
    return '<button type="button" class="acopt' + (on ? " on" : "") + '" data-k="' + k + '" data-v="' + esc(v) + '" aria-pressed="' + on + '"><b>' + esc(v) + (tag ? ' <em>' + esc(tag) + "</em>" : "") + "</b><span>" + esc(txt) + "</span></button>";
  }
  function vStep2() {
    var h = '<h2>Waar komt de airco?</h2>' + chips("locatie", ["Woning", "Appartement", "Bedrijf"], S.locatie);
    if (S.locatie === "Bedrijf") {
      h += '<div class="acsub"><label class="acl">Type bedrijf</label>' + chips("btype", BEDRIJF, S.bedrijf.type) +
        '<div class="acrow"><label class="acl">Oppervlakte (m²)<input type="number" inputmode="numeric" min="1" data-f="bm2" value="' + esc(S.bedrijf.m2) + '"></label>' +
        '<label class="acl">Aantal personen<input type="number" inputmode="numeric" min="0" data-f="bpers" value="' + esc(S.bedrijf.pers) + '"></label></div>' +
        '<label class="acl">Apparatuur die warmte geeft</label>' + chips("bapp", ["Weinig", "Normaal", "Veel (servers, ovens, verlichting)"], S.bedrijf.app) + "</div>";
    }
    return h;
  }
  function vStep3() {
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
    if (S.rooms.length > 1 && S.systeem !== "Monoblock zonder buitenunit") {
      h += '<div class="acsub"><label class="acl">Hoeveel buitenunits?</label>' + chips("buiten", ["1", "2", "3", "4", "Adviseer mij"], S.buiten) +
        '<p class="small">Eén buitenunit voor meerdere ruimtes heet een multisplit: minder aan de gevel, vaak voordeliger.</p></div>';
    }
    return h;
  }
  function vStep4() {
    return '<h2>Wat vindt u belangrijk?</h2><p class="small">Kies zoveel als u wilt.</p>' + chips("wensen", WENSEN, S.wensen, true) +
      '<p class="acnote">Hoe meer wensen u aanvinkt, hoe hoger de prijs kan uitvallen. Wij zoeken altijd de beste balans.</p>';
  }
  function inp(f, label, type, ac, extra) {
    return '<label class="acl">' + label + ' *<input required type="' + type + '" data-f="' + f + '" autocomplete="' + ac + '" value="' + esc(S.c[f]) + '"' + (extra || "") + '><small class="acerr" data-e="' + f + '"></small></label>';
  }
  function vStep5() {
    return '<h2>Uw contactgegevens</h2><p class="small">Wanneer bereiken wij u het best?</p>' +
      chips("dagdeel", ["Voormiddag", "Namiddag", "Avond", "Maakt niet uit"], S.dagdeel) +
      '<div class="acrow">' + inp("voornaam", "Voornaam", "text", "given-name") + inp("naam", "Naam", "text", "family-name") + "</div>" +
      '<div class="acrow">' + inp("gsm", "Gsm", "tel", "tel", ' inputmode="tel" placeholder="04xx xx xx xx"') + inp("email", "E-mail", "email", "email") + "</div>" +
      inp("straat", "Straat en nr", "text", "street-address") +
      '<div class="acrow">' + inp("postcode", "Postcode", "text", "postal-code", ' inputmode="numeric" maxlength="4"') + inp("gemeente", "Gemeente", "text", "address-level2") + "</div>" +
      '<p class="small acpriv">Door te verzenden gaat u akkoord met ons <a href="/privacy/">privacybeleid</a>. Uw gegevens gebruiken wij enkel voor uw offerte.</p>' +
      '<p class="acerr" id="acsenderr"></p>';
  }
  function vStep6() {
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

  function valid(n) {
    if (n === 1) return !!S.systeem;
    if (n === 2) return !!S.locatie && (S.locatie !== "Bedrijf" || !!S.bedrijf.type);
    if (n === 3) return roomsOk();
    if (n === 4) return true;
    if (n === 5) return !!S.dagdeel && S.c.voornaam && S.c.naam && gsmOk(S.c.gsm) && mailOk(S.c.email) && S.c.straat && /^\d{4}$/.test(S.c.postcode) && S.c.gemeente;
    return true;
  }
  function hint(n) {
    if (n === 1) return "Kies een systeem.";
    if (n === 2) return S.locatie === "Bedrijf" ? "Kies het type bedrijf." : "Kies waar de airco komt.";
    if (n === 3) return !S.n ? "Kies het aantal ruimtes." : (S.rooms.length > 1 && S.systeem !== "Monoblock zonder buitenunit" && !S.buiten ? "Kies het aantal buitenunits." : "Vul elke ruimte volledig in.");
    if (n === 5) return "Vul alle velden correct in en kies een dagdeel.";
    return "";
  }

  function render() {
    var n = S.step, view = [vStep1, vStep2, vStep3, vStep4, vStep5, vStep6][n - 1]();
    var pct = Math.round(((n - 1) / 5) * 100);
    root.innerHTML =
      (restored && n < 6 ? '<p class="acresume">Welkom terug, u gaat verder waar u was. <button type="button" data-reset="1">Opnieuw beginnen</button></p>' : "") +
      '<div class="acprog" aria-hidden="true"><i style="width:' + pct + '%"></i></div>' +
      '<p class="acstep">Stap ' + Math.min(n, 6) + " van 6 · " + STEPS[n - 1] + "</p>" +
      '<div class="acbody">' + view + "</div>" +
      (n < 6 ? '<div class="acnav">' + (n > 1 ? '<button type="button" class="btn s" data-back="1">Terug</button>' : "<span></span>") +
        '<button type="button" class="btn p lg" data-next="1"' + (valid(n) ? "" : ' aria-disabled="true"') + ">" + (n === 5 ? "Verstuur en bekijk resultaat" : "Volgende") + "</button></div>" +
        '<p class="achint" aria-live="polite"></p>' : "");
    if (n === 5) wireInputs();
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
    if (valid(S.step)) b.removeAttribute("aria-disabled"); else b.setAttribute("aria-disabled", "true");
  }

  function setVal(k, v) {
    if (k === "systeem") { S.systeem = v; if (v === "Monoblock zonder buitenunit") S.buiten = ""; }
    else if (k === "locatie") S.locatie = v;
    else if (k === "btype") S.bedrijf.type = v;
    else if (k === "bapp") S.bedrijf.app = v;
    else if (k === "n") { S.n = v; setRooms(v); }
    else if (k === "buiten") S.buiten = v;
    else if (k === "dagdeel") S.dagdeel = v;
    else if (k === "wensen") { var i = S.wensen.indexOf(v); if (i > -1) S.wensen.splice(i, 1); else S.wensen.push(v); }
    else if (k.charAt(0) === "r") { var p = k.slice(1).split("."); S.rooms[+p[0]][p[1]] = v; }
  }

  function payload() {
    var kws = S.rooms.map(kw), tot = kws.reduce(function (a, b) { return a + b; }, 0);
    var mob = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    var d = {
      "form-name": "aircocheck", "bot-field": "",
      systeem: S.systeem, locatie: S.locatie,
      bedrijf_type: S.bedrijf.type, bedrijf_m2: S.bedrijf.m2, bedrijf_personen: S.bedrijf.pers, bedrijf_apparatuur: S.bedrijf.app,
      aantal_ruimtes: String(S.rooms.length),
      ruimtes: S.rooms.map(function (r, i) { return "Ruimte " + (i + 1) + ": " + r.type + ", " + r.m2 + ", " + r.ori + ", glas " + r.glas.toLowerCase() + ", isolatie " + r.iso.toLowerCase() + " → ± " + fmt(kws[i]) + " kW"; }).join(" | "),
      ruimtes_json: JSON.stringify(S.rooms.map(function (r, i) { return { type: r.type, m2: r.m2, ori: r.ori, glas: r.glas, iso: r.iso, kw: kws[i] }; })),
      kw_totaal: fmt(tot), buitenunits: S.buiten || (S.rooms.length === 1 ? "1" : ""),
      wensen: S.wensen.join(", "), dagdeel: S.dagdeel,
      voornaam: S.c.voornaam, naam: S.c.naam, gsm: gsmFmt(S.c.gsm), email: S.c.email,
      straat: S.c.straat, postcode: S.c.postcode, gemeente: S.c.gemeente,
      bron_pagina: document.referrer ? (function () { try { return new URL(document.referrer).pathname; } catch (e) { return document.referrer; } })() : "direct",
      landingspagina: (function () { try { return sessionStorage.getItem("sc_land") || location.pathname; } catch (e) { return location.pathname; } })(),
      apparaat: mob ? "mobiel" : "desktop",
      duur_sec: String(Math.round((Date.now() - (S.t0 || T0)) / 1000))
    };
    return d;
  }

  function send() {
    var btn = root.querySelector("[data-next]"); if (btn) { btn.setAttribute("aria-disabled", "true"); btn.textContent = "Bezig met verzenden…"; }
    var body = new URLSearchParams(payload()).toString();
    fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body })
      .then(function (r) { if (!r.ok) throw new Error(r.status); S.sent = true; S.step = 6; clearSave(); render(); track(6); window.scrollTo(0, root.offsetTop - 90); })
      .catch(function () {
        var e = document.getElementById("acsenderr");
        if (e) e.innerHTML = 'Verzenden lukte niet. Probeer opnieuw, of <a href="' + (window.SC_WA || "#") + '" target="_blank" rel="noopener">stuur ons een WhatsApp</a>.';
        if (btn) { btn.removeAttribute("aria-disabled"); btn.textContent = "Verstuur en bekijk resultaat"; }
      });
  }

  root.addEventListener("click", function (ev) {
    var t = ev.target.closest("button"); if (!t || !root.contains(t)) return;
    if (t.dataset.reset) { clearSave(); location.reload(); return; }
    if (t.dataset.k) { setVal(t.dataset.k, t.dataset.v); save(); render(); return; }
    if (t.dataset.add) { if (S.rooms.length < 8) S.rooms.push(blankRoom()); save(); render(); return; }
    if (t.dataset.del) { S.rooms.splice(+t.dataset.del, 1); save(); render(); return; }
    if (t.dataset.back) { S.step = Math.max(1, S.step - 1); save(); render(); track(S.step); window.scrollTo(0, root.offsetTop - 90); return; }
    if (t.dataset.next) {
      if (!valid(S.step)) { var h = root.querySelector(".achint"); if (h) h.textContent = hint(S.step); return; }
      if (S.step === 5) { send(); return; }
      S.step += 1; save(); render(); track(S.step); window.scrollTo(0, root.offsetTop - 90);
    }
  });

  render(); track(S.step);
})();
