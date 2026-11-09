// netlify/functions/kras-claim.js — VERVANGEN (9/11/2026). De kraskaart loopt nu via kras-reveal + Aircocheck.
exports.handler = async () => ({ statusCode: 410, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "Deze versie van de kraskaart bestaat niet meer. Ga naar smartcooling.be/kras" }) });
