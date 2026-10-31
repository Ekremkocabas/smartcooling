// netlify/functions/lead-process-background.js  (v11)
// Background function (tot 15 min): Odoo lead/offerte met 3 pogingen, daarna lead-mail via Brevo.
const crypto = require("crypto");
const { processLead } = require("./lib/lead.js");
const token = () => crypto.createHash("sha256").update("lead:" + (process.env.ODOO_API_KEY || "")).digest("hex");

exports.handler = async (event) => {
  const h = event.headers || {};
  if ((h["x-lead-token"] || h["X-Lead-Token"]) !== token()) { console.warn("lead-process: ongeldig token"); return { statusCode: 403, body: "forbidden" }; }
  let payload = {};
  try { payload = JSON.parse(event.body || "{}").payload || {}; } catch (e) { return { statusCode: 400, body: "bad json" }; }
  const out = await processLead(payload, { attempts: 3, odooTimeout: 40000, waitMs: (process.env.FAST_TEST ? [50,50] : [20000, 40000]) });
  console.log("lead-process klaar:", JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
};
