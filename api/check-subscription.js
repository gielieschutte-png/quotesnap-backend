// /api/check-subscription.js
// Azanco — Subscription Status Check (Final)
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// Known GHL custom field IDs for the Azanco location — confirmed via debug
// logging (2 Sept 2026 for the date fields, 3 Sept 2026 for status/tier).
//
// FIX (3 Sept 2026): subscription_status and subscription_tier used to be
// guessed by scanning EVERY custom field on the contact and matching
// whichever one's VALUE happened to equal a known status/tier string. That's
// the same landmine already hit and fixed elsewhere in this project
// (revert-discount-price.js's tier lookup, cancel-subscription.js's token
// lookup) — GHL's read API returns fields by ID, and matching by value
// shape instead is fragile and can silently pick the wrong field. This is
// very likely why editing subscription_status directly in GHL wasn't
// reliably reflected in the banner. Now matched by explicit field ID, same
// as the date fields below.
const FIELD_IDS = {
  trial_ends_at: "i3SxnqhfoK0fEVGXrpYM",
  next_billing_date: "d7T5YIxFSwX3wBs2gpDm",
  subscription_status: "W3QRXXKNG8Xus36NaPBx",
  subscription_tier: "Tir7pwVADQwH6NaZ15oP",
};

const VALID_STATUSES = ["trial", "active", "grace", "locked", "cancelled"];
const VALID_TIERS = ["tier1", "tier_1", "tier2", "tier_2", "tier3", "tier_3"];

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

    // Verify exact email match — GHL's query search can be fuzzy and
    // return the wrong contact first.
    const contact = contacts.find(
      (c) => (c.email || "").toLowerCase() === email.toLowerCase()
    );

    if (!contact) {
      console.log(`No exact-match contact found for: ${email}`);
      return res.status(200).json({ status: "trial", tier: null, next_billing_date: null, trial_ends_at: null, trial_days_remaining: null });
    }

    console.log(`Matched contact: ${contact.id} for email: ${email}`);
    const customFields = contact.customFields || [];
    console.log("ALL FIELDS:", customFields.map(f => `${f.id}=${JSON.stringify(f.value)}`).join(" | "));

    // Converts a GHL date-picker field's raw value (returned as
    // milliseconds-since-epoch) into a "YYYY-MM-DD" string.
    function msToDateStr(rawVal) {
      const ms = Number(rawVal);
      if (isNaN(ms) || ms <= 0) return null;
      return new Date(ms).toISOString().split("T")[0];
    }

    // Pull a field's raw value (unwrapping the array GHL uses for
    // Dropdown-multiple fields), by exact field ID — not by guessing.
    function getFieldValue(fieldId) {
      const field = customFields.find((f) => f.id === fieldId);
      if (!field) return null;
      const val = Array.isArray(field.value) ? field.value[0] : field.value;
      if (val === undefined || val === null || val === "") return null;
      return String(val).trim();
    }

    let status = "trial";
    const rawStatus = getFieldValue(FIELD_IDS.subscription_status);
    if (rawStatus && VALID_STATUSES.includes(rawStatus)) {
      status = rawStatus;
    } else if (rawStatus) {
      console.warn(`subscription_status held an unrecognised value "${rawStatus}" — defaulting to "trial"`);
    }

    let tier = null;
    const rawTier = getFieldValue(FIELD_IDS.subscription_tier);
    if (rawTier && VALID_TIERS.includes(rawTier)) {
      tier = rawTier;
    }

    const trial_ends_at = msToDateStr(getFieldValue(FIELD_IDS.trial_ends_at));
    const next_billing_date = msToDateStr(getFieldValue(FIELD_IDS.next_billing_date));

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
