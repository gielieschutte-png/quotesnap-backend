// /api/check-subscription.js
// Azanco — Subscription Status Check (Final Version)
// GHL returns customFields with internal IDs not key names.
// We match by known field IDs extracted from diagnostic response.
 
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
 
// GHL internal field IDs (from diagnostic response)
const FIELD_IDS = {
  subscription_tier: "Tir7pwVADQwH6NaZI5oP",
  subscription_status: "W3QRXXkNG8Xus36NaPBx",
};
 
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
 
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
 
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email is required" });
 
  try {
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-07-28",
        },
      }
    );
 
    const searchData = await searchRes.json();
    const contacts = searchData?.contacts || [];
 
    if (!contacts.length) {
      console.log(`No GHL contact found for email: ${email} — defaulting to trial`);
      return res.status(200).json({
        status: "trial",
        tier: null,
        next_billing_date: null,
        trial_ends_at: null,
        trial_days_remaining: null,
      });
    }
 
    const contact = contacts[0];
    const customFields = contact.customFields || [];
 
    // Match fields by internal GHL ID
    const getFieldById = (id) => {
      const field = customFields.find((f) => f.id === id);
      if (!field) return null;
      // value can be array or string
      if (Array.isArray(field.value)) return field.value[0] || null;
      return field.value || null;
    };
 
    const status = getFieldById(FIELD_IDS.subscription_status) || "trial";
    const tier = getFieldById(FIELD_IDS.subscription_tier) || null;
 
    // For next_billing_date and trial_ends_at we don't have IDs yet
    // Will add once confirmed from diagnostic — for now return nulls
    const next_billing_date = null;
    const trial_ends_at = null;
    let trial_days_remaining = null;
 
    return res.status(200).json({
      status,
      tier,
      next_billing_date,
      trial_ends_at,
      trial_days_remaining,
    });
 
  } catch (err) {
    console.error("check-subscription error:", err);
    return res.status(200).json({
      status: "trial",
      tier: null,
      next_billing_date: null,
      trial_ends_at: null,
      trial_days_remaining: null,
    });
  }
}
