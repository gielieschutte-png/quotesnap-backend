// /api/check-subscription.js
// Azanco — Subscription Status Check (Working Version)

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

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
      return res.status(200).json({ status: "trial", tier: null, next_billing_date: null, trial_ends_at: null, trial_days_remaining: null });
    }

    const contact = contacts[0];
    const customFields = contact.customFields || [];

    // GHL returns customFields as array of objects
    // Use Object.keys to find the right property name dynamically
    let status = "trial";
    let tier = null;

    for (const field of customFields) {
      // Get all keys of this field object
      const keys = Object.keys(field);
      console.log(`Field keys: ${JSON.stringify(keys)}, field: ${JSON.stringify(field)}`);
      
      const idKey = keys.find(k => k.toLowerCase() === "id");
      const valueKey = keys.find(k => k.toLowerCase() === "value");
      
      if (!idKey || !valueKey) continue;
      
      const fieldId = field[idKey];
      let fieldValue = field[valueKey];
      if (Array.isArray(fieldValue)) fieldValue = fieldValue[0] || null;

      if (fieldId === "W3QRXXkNG8Xus36NaPBx") status = fieldValue || "trial";
      if (fieldId === "Tir7pwVADQwH6NaZI5oP") tier = fieldValue;
    }

    console.log(`Result: status=${status}, tier=${tier}`);

    return res.status(200).json({
      status,
      tier,
      next_billing_date: null,
      trial_ends_at: null,
      trial_days_remaining: null,
    });

  } catch (err) {
    console.error("Error:", err);
    return res.status(200).json({ status: "trial", tier: null, next_billing_date: null, trial_ends_at: null, trial_days_remaining: null });
  }
}
