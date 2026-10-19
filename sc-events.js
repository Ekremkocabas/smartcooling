/* Smart Cooling – GA4 events (v1): WhatsApp, e-mail, telefoon, offerteformulier */
(function(){
  function ev(n,p){ try{ if(typeof gtag==="function") gtag("event",n,p||{}); }catch(e){} }
  document.addEventListener("click",function(e){
    var a=e.target.closest("a"); if(!a) return;
    var h=a.getAttribute("href")||"";
    if(/wa\.me|whatsapp/i.test(h)) ev("whatsapp_click",{page:location.pathname});
    else if(h.indexOf("mailto:")===0) ev("email_click",{page:location.pathname});
    else if(h.indexOf("tel:")===0) ev("phone_click",{page:location.pathname});
    else if(/\/aircocheck\//.test(h)) ev("aircocheck_open",{page:location.pathname});
  },true);
  document.addEventListener("submit",function(e){
    var f=e.target; if(f&&f.getAttribute("name")==="offerte") ev("generate_lead",{form:"offerte",page:location.pathname});
  },true);
})();
