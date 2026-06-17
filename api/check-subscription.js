// /api/check-subscription.js
// Azanco — Subscription Status Check
// Base44 calls this on every login to get the subscription status for a company.
// This keeps the GHL API key safe on the server — never exposed to the frontend.

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

export default async function handler(req, res) {
  // Allow Base44 to call this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    // Search GHL for contact by email
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-07-28",
        },
      }
    );

    const { data: searchData, error: searchError } = await searchRes.json().then(
      (d) => ({ data: d, error: null }),
      (e) => ({ data: null, error: e })
    );

    if (searchError || !searchData?.contacts?.length) {
      // Contact not found in GHL — treat as trial so they're not locked out
      console.log(`No GHL contact found for email: ${email} — defaulting to trial`);
      return res.status(200).json({
        status: "trial",
        tier: null,
        next_billing_date: null,
        trial_ends_at: null,
      });
    }

    // Get the first matching contact
    const contact = searchData.contacts[0];
    const customFields = contact.customFields || [];

    // Extract Azanco custom field values
    const getField = (key) => {
      const field = customFields.find((f) => f.key === key);
      return field?.value || null;
    };

    const status = getField("subscription_status") || "trial";
    const tier = getField("subscription_tier") || null;
    const next_billing_date = getField("next_billing_date") || null;
    const trial_ends_at = getField("trial_ends_at") || null;

    // Calculate days remaining for trial
    let trial_days_remaining = null;
    if (trial_ends_at) {
      const end = new Date(trial_ends_at);
      const now = new Date();
      const diff = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
      trial_days_remaining = diff > 0 ? diff : 0;
    }

    return res.status(200).json({
      status,
      tier,
      next_billing_date,
      trial_ends_at,
      trial_days_remaining,
    });

  } catch (err) {
    console.error("check-subscription error:", err);
    // On error, default to trial so users aren't accidentally locked out
    return res.status(200).json({
      status: "trial",
      tier: null,
      next_billing_date: null,
      trial_ends_at: null,
    });
  }
}
