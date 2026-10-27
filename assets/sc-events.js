/* Smart Cooling – GA4 + Meta-pixel events + cookiebalk (v4, 27/10/2026)
   Meta-pixel (gegevensset 1051193000696447) laadt ENKEL na toestemming ("Oké").
   Events: PageView, Lead (offerteformulier via /bedankt/ + Aircocheck), Contact (WhatsApp/telefoon/e-mail). */
(function(){
  var KEY="sc_cookie_v2";            /* v2: nieuwe toestemming nodig omdat marketingcookies erbij komen */
  var PIXEL="1051193000696447";
  var consent=false;
  function g(){ return typeof gtag==="function"; }
  function ev(n,p){ try{ if(g()) gtag("event",n,p||{}); }catch(e){} }

  function loadPixel(){
    if(window.fbq) return;
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    window.fbq("init",PIXEL);
    window.fbq("track","PageView");
    if(/^\/bedankt\/?$/.test(location.pathname)) window.fbq("track","Lead",{content_name:"offerteformulier"});
  }
  function fb(n,p){ try{ if(consent&&window.fbq) window.fbq("track",n,p||{}); }catch(e){} }
  /* publiek haakje voor andere scripts (Aircocheck) */
  window.scTrack=function(n,p){ fb(n,p); };

  function grant(){
    consent=true;
    try{ if(g()) gtag("consent","update",{"analytics_storage":"granted","ad_storage":"granted","ad_user_data":"granted","ad_personalization":"granted"}); }catch(e){}
    loadPixel();
  }

  var choice=null; try{ choice=localStorage.getItem(KEY); }catch(e){}
  if(choice==="ja") grant();
  else if(choice!=="nee") showBar();

  function showBar(){
    if(document.getElementById("sc-cookie")) return;
    var s=document.createElement("style");
    s.textContent="#sc-cookie{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;background:#0A1622;color:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.25);font:15px/1.5 Inter,system-ui,sans-serif;display:flex;gap:12px;align-items:center;flex-wrap:wrap;max-width:720px;margin:0 auto}#sc-cookie p{margin:0;flex:1 1 260px}#sc-cookie a{color:#8FD6F2}#sc-cookie .b{display:flex;gap:8px}#sc-cookie button{border:0;border-radius:999px;padding:10px 18px;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}#sc-cookie .ok{background:#46B4E8;color:#0A1622}#sc-cookie .no{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.4)}@media(max-width:560px){#sc-cookie{bottom:70px}}";
    document.head.appendChild(s);
    var d=document.createElement("div"); d.id="sc-cookie"; d.setAttribute("role","dialog"); d.setAttribute("aria-label","Cookies");
    d.innerHTML='<p>Met uw toestemming gebruiken wij cookies voor statistiek (Google Analytics) en om onze advertenties op Facebook en Instagram te meten (Meta-pixel). <a href="/privacy/">Privacybeleid</a></p><div class="b"><button type="button" class="ok">Oké</button><button type="button" class="no">Weigeren</button></div>';
    d.querySelector(".ok").onclick=function(){ try{localStorage.setItem(KEY,"ja");}catch(e){} grant(); d.remove(); };
    d.querySelector(".no").onclick=function(){ try{localStorage.setItem(KEY,"nee");}catch(e){} d.remove(); };
    if(document.body) document.body.appendChild(d); else document.addEventListener("DOMContentLoaded",function(){document.body.appendChild(d);});
  }

  document.addEventListener("click",function(e){
    var a=e.target.closest("a"); if(!a) return;
    var h=a.getAttribute("href")||"";
    if(/wa\.me|whatsapp/i.test(h)){ ev("whatsapp_click",{page:location.pathname}); fb("Contact",{content_name:"whatsapp"}); }
    else if(h.indexOf("mailto:")===0){ ev("email_click",{page:location.pathname}); fb("Contact",{content_name:"email"}); }
    else if(h.indexOf("tel:")===0){ ev("phone_click",{page:location.pathname}); fb("Contact",{content_name:"telefoon"}); }
    else if(/\/aircocheck\//.test(h)) ev("aircocheck_open",{page:location.pathname});
  },true);
  document.addEventListener("submit",function(e){
    var f=e.target; if(f&&f.getAttribute("name")==="offerte") ev("generate_lead",{form:"offerte",page:location.pathname});
  },true);
})();
