// /api/check-subscription.js
// Azanco — Subscription Status Check
// Matches GHL custom fields by key name (e.g. "subscription_status")

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

    // GHL v2021-07-28 returns customFields on contact
    // but also returns individual fields as top-level contact properties via customField key
    // Try both approaches

    // Approach 1: customFields array
    const customFields = contact.customFields || [];
    console.log(`customFields count: ${customFields.length}`);
    console.log(`Full customFields: ${JSON.stringify(customFields)}`);

    // Approach 2: check contact.customField (object format some API versions return)
    const customFieldObj = contact.customField || {};
    console.log(`customField object: ${JSON.stringify(customFieldObj)}`);

    // Try to get values from object format first (keyed by field key name)
    let status = customFieldObj["subscription_status"] || null;
    let tier = customFieldObj["subscription_tier"] || null;

    // If not found in object, try array format by checking all fields
    if (!status && customFields.length > 0) {
      for (const field of customFields) {
        const allProps = JSON.stringify(field);
        console.log(`Checking field: ${allProps}`);
        
        // Check every string value in the field object
        const val = Array.isArray(field.value) ? field.value[0] : field.value;
        
        // Match by known values
        if (["trial", "active", "grace", "locked"].includes(val)) {
          status = val;
          console.log(`Found status via value match: ${status}`);
        }
        if (["tier1", "tier_1", "tier2", "tier_2", "tier3", "tier_3"].includes(val)) {
          tier = val;
          console.log(`Found tier via value match: ${tier}`);
        }
        if (Array.isArray(field.value)) {
          for (const v of field.value) {
            if (["tier1", "tier_1", "tier2", "tier_2", "tier3", "tier_3"].includes(v)) {
              tier = v;
            }
          }
        }
      }
    }

    status = status || "trial";
    console.log(`Final: status=${status}, tier=${tier}`);

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
