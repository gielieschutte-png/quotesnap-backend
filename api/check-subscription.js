// /api/check-subscription.js
// Azanco — Subscription Status Check v3 with debug logging

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

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

    console.log(`Contacts found: ${contacts.length}`);

    if (!contacts.length) {
      console.log(`No contact found for: ${email}`);
      return res.status(200).json({ status: "trial", tier: null, next_billing_date: null, trial_ends_at: null, trial_days_remaining: null });
    }

    const contact = contacts[0];
    const customFields = contact.customFields || [];

    console.log(`Custom fields raw: ${JSON.stringify(customFields)}`);

    const getFieldById = (id) => {
      const field = customFields.find((f) => f.id === id);
      console.log(`Looking for ID ${id}: found=${JSON.stringify(field)}`);
      if (!field) return null;
      if (Array.isArray(field.value)) return field.value[0] || null;
      return field.value || null;
    };

    const status = getFieldById(FIELD_IDS.subscription_status) || "trial";
    const tier = getFieldById(FIELD_IDS.subscription_tier) || null;

    console.log(`Final status: ${status}, tier: ${tier}`);

    return res.status(200).json({
      status,
      tier,
      next_billing_date: null,
      trial_ends_at: null,
      trial_days_remaining: null,
    });

  } catch (err) {
    console.error("check-subscription error:", err);
    return res.status(200).json({ status: "trial", tier: null, next_billing_date: null, trial_ends_at: null, trial_days_remaining: null });
  }
}
