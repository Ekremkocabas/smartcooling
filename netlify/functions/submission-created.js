// netlify/functions/submission-created.js
// Runs AUTOMATICALLY on every verified Netlify form submission.
// It creates a lead directly in Odoo CRM (smart-tech2026) with clean fields,
// sets the Monoblock flag (your existing Odoo automation then routes it to the
// Monoblock pipeline), and stamps the source as "Website".
//
// Connection details come from Netlify environment variables (set in the
// Netlify UI) so no secrets live in this file:
//   ODOO_URL      e.g. https://smart-tech2026.odoo.com
//   ODOO_DB       e.g. smart-tech2026
//   ODOO_LOGIN    your Odoo login (e-mail)
//   ODOO_API_KEY  the API key you create in Odoo
//
// Fixed (not secret) references:
const WEBSITE_SOURCE_ID = 18;   // utm.source "Website"
const TEAM_SALES = 1;           // Verkoop (Airco)
const TEAM_MONOBLOCK = 4;       // Monoblock
const STAGE_NIEUW = 1;          // "Nieuw Lead"

exports.handler = async (event) => {
  try {
    const payload = JSON.parse(event.body || "{}").payload || {};
    // Only handle the offerte form; ignore any other future forms.
    if (payload.form_name && payload.form_name !== "offerte") {
      return { statusCode: 200, body: "ignored (other form)" };
    }
    const d = payload.data || {};

    const URL = process.env.ODOO_URL;
    const DB = process.env.ODOO_DB;
    const LOGIN = process.env.ODOO_LOGIN;
    const KEY = process.env.ODOO_API_KEY;
    if (!URL || !DB || !LOGIN || !KEY) {
      console.error("Missing Odoo env vars");
      return { statusCode: 200, body: "missing env vars (logged)" };
    }

    const rpc = async (service, method, args) => {
      const res = await fetch(`${URL}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: { service, method, args },
        }),
      });
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    };

    // 1) authenticate -> uid
    const uid = await rpc("common", "authenticate", [DB, LOGIN, KEY, {}]);
    if (!uid) throw new Error("Odoo authentication failed (check login/API key)");

    // 2) build the lead values from the form data
    const systeem = (d.systeem || "").toString();
    const isMono = /monoblock/i.test(systeem);
    const naam = [d.voornaam, d.naam].filter(Boolean).join(" ").trim();
    const straat = [d.straat, d.huisnr].filter(Boolean).join(" ").trim();
    const ruimte = Array.isArray(d.ruimte) ? d.ruimte.join(", ") : (d.ruimte || "");

    const description = [
      "Aanvraag via website (smartcooling.be)",
      `Type: ${systeem || "-"}`,
      `Aantal airco('s): ${d.aantal || "-"}`,
      `Gewenste plaatsingsdatum: ${d.plaatsingsdatum || "-"}`,
      `Gewenst belmoment: ${d.belmoment || "-"}`,
      `Type ruimte: ${ruimte || "-"}`,
      "",
      `Bericht: ${d.bericht || "-"}`,
    ].join("\n");

    const vals = {
      name: `Website aanvraag - ${naam || "onbekend"}`,
      type: "opportunity",
      contact_name: naam,
      phone: d.telefoon || "",
      email_from: d.email || "",
      street: straat,
      zip: d.postcode || "",
      city: d.gemeente || "",
      description: description,
      x_studio_is_monoblock: isMono,
      team_id: isMono ? TEAM_MONOBLOCK : TEAM_SALES,
      stage_id: STAGE_NIEUW,
      source_id: WEBSITE_SOURCE_ID,
    };

    // 3) create the lead
    const leadId = await rpc("object", "execute_kw", [
      DB, uid, KEY, "crm.lead", "create", [vals],
    ]);

    console.log("Odoo lead created:", leadId, "monoblock:", isMono);
    return { statusCode: 200, body: JSON.stringify({ ok: true, leadId }) };
  } catch (e) {
    // Return 200 so Netlify does not keep retrying; the error is logged.
    console.error("lead-to-odoo error:", e);
    return { statusCode: 200, body: "error logged" };
  }
};
