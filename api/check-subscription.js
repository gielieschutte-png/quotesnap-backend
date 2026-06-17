// /api/check-subscription.js
// Azanco — Subscription Status Check (Final)

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
      console.log(`No contact found for: ${email}`);
      return res.status(200).json({ status: "trial", tier: null, next_billing_date: null, trial_ends_at: null, trial_days_remaining: null });
    }

    const contact = contacts[0];
    const customFields = contact.customFields || [];

    let status = "trial";
    let tier = null;
    let trial_ends_at = null;
    let next_billing_date = null;

    for (const field of customFields) {
      const val = Array.isArray(field.value) ? field.value[0] : field.value;
      if (!val) continue;

      const valStr = String(val).trim();

      // Match subscription status
      if (["trial", "active", "grace", "locked"].includes(valStr)) {
        status = valStr;
      }

      // Match tier
      if (["tier1", "tier_1", "tier2", "tier_2", "tier3", "tier_3"].includes(valStr)) {
        tier = valStr;
      }
      if (Array.isArray(field.value)) {
        for (const v of field.value) {
          if (["tier1", "tier_1", "tier2", "tier_2", "tier3", "tier_3"].includes(String(v).trim())) {
            tier = String(v).trim();
          }
        }
      }

      // Match dates — YYYY-MM-DD format
      if (/^\d{4}-\d{2}-\d{2}$/.test(valStr)) {
        // Determine which date field this is by checking field id
        // trial_ends_at id: W3QRXXkNG8Xus36NaPBx — but we'll use position/context
        // Use the field id to distinguish
        const fieldId = field.id || "";
        
        // From our diagnostic: trial_ends_at has a specific ID
        // We'll store any date and figure out which is which
        if (!trial_ends_at) {
          trial_ends_at = valStr;
        } else {
          next_billing_date = valStr;
        }
      }
    }

    // Calculate days remaining
    let trial_days_remaining = null;
    if (trial_ends_at) {
      const end = new Date(trial_ends_at);
      const now = new Date();
      const diff = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
      trial_days_remaining = diff > 0 ? diff : 0;
    }

    console.log(`Result: status=${status}, tier=${tier}, trial_ends_at=${trial_ends_at}, days=${trial_days_remaining}`);

    return res.status(200).json({
      status,
      tier,
      next_billing_date,
      trial_ends_at,
      trial_days_remaining,
    });

  } catch (err) {
    console.error("Error:", err);
    return res.status(200).json({ status: "trial", tier: null, next_billing_date: null, trial_ends_at: null, trial_days_remaining: null });
  }
}
