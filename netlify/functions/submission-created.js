// netlify/functions/submission-created.js  (v11)
// Draait automatisch bij elke Netlify-formulierinzending (max. 10 s). Geeft het werk door aan
// lead-process-background (tot 15 min, 3 Odoo-pogingen) en valt terug op directe verwerking als dat niet lukt.
const crypto = require("crypto");
const { processLead } = require("./lib/lead.js");
const token = () => crypto.createHash("sha256").update("lead:" + (process.env.ODOO_API_KEY || "")).digest("hex");

exports.handler = async (event) => {
  let payload = {};
  try { payload = JSON.parse(event.body || "{}").payload || {}; } catch (e) { return { statusCode: 200, body: "bad json" }; }
  const base = process.env.URL || "https://smartcooling.be";
  try {
    const r = await fetch(base + "/.netlify/functions/lead-process-background", {
      method: "POST", headers: { "Content-Type": "application/json", "x-lead-token": token() }, body: JSON.stringify({ payload }),
    });
    if (r.status === 202 || r.status === 200) { console.log("lead doorgegeven aan background (" + r.status + ")"); return { statusCode: 200, body: "queued" }; }
    console.warn("background weigerde (" + r.status + "), directe verwerking");
  } catch (e) { console.warn("background niet bereikbaar, directe verwerking:", e.message); }
  const out = await processLead(payload, { attempts: 1, odooTimeout: 8000 });
  return { statusCode: 200, body: JSON.stringify(out) };
};
exports._token = token;
