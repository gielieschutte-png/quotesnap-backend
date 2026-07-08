// /api/check-subscription.js
// Azanco — Subscription Status Check (Final)
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Known GHL custom field IDs for the Azanco location — confirmed via debug
// logging on 7-8 July 2026. These are location-wide (same field = same ID
// across every contact in this GHL sub-account), so safe to hardcode here
// the same way sync-tier-to-payfast.js and cancel-subscription.js do.
const FIELD_IDS = {
  trial_ends_at: "xLH9TyB1bAc5dBMEX2PD",
  next_billing_date: "d7T5YIxFSwX3wBs2gpDm",
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

    // FIX: verify exact email match — GHL's query search can be fuzzy and
    // return the wrong contact first. Every other Azanco endpoint already
    // does this check; this one was missing it.
    const contact = contacts.find(
      (c) => (c.email || "").toLowerCase() === email.toLowerCase()
    );

    if (!contact) {
      console.log(`No exact-match contact found for: ${email}`);
      return res.status(200).json({ status: "trial", tier: null, next_billing_date: null, trial_ends_at: null, trial_days_remaining: null });
    }

    console.log(`Matched contact: ${contact.id} for email: ${email}`);

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
      if (["trial", "active", "grace", "locked", "cancelled"].includes(valStr)) {
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

      // FIX: match date fields by their real GHL field ID, not by
      // "whichever one we saw first" — the old positional guess could
      // easily assign next_billing_date's value to trial_ends_at or
      // vice versa depending on array order.
      if (field.id === FIELD_IDS.trial_ends_at && /^\d{4}-\d{2}-\d{2}$/.test(valStr)) {
        trial_ends_at = valStr;
      }
      if (field.id === FIELD_IDS.next_billing_date && /^\d{4}-\d{2}-\d{2}$/.test(valStr)) {
        next_billing_date = valStr;
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

    console.log(`Result: contact=${contact.id}, status=${status}, tier=${tier}, trial_ends_at=${trial_ends_at}, next_billing_date=${next_billing_date}, days=${trial_days_remaining}`);

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
