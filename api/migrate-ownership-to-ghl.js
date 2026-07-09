// api/migrate-ownership-to-ghl.js - Vercel Serverless Function
//
// Closes the gap identified 9 July 2026: Base44's transferOwnership function
// updates BusinessProfile.owner_id but makes ZERO external calls — GHL and
// PayFast never learn ownership changed. Since check-subscription.js,
// cancel-subscription.js, and sync-tier-to-payfast.js all resolve everything
// via the OWNER's GHL contact, a transferred-to owner would appear to have
// no subscription at all (their own GHL contact still says trial) even
// though a real, active PayFast subscription is running under the
// PREVIOUS owner's contact.
//
// This endpoint copies the subscription-relevant fields from the old
// owner's GHL contact to the new owner's — no PayFast call needed, since
// PayFast's billing relationship doesn't care which Azanco user is
// "the owner," only GHL's bookkeeping does.
//
// Called with: POST { oldOwnerEmail: string, newOwnerEmail: string }

const FIELDS_TO_MIGRATE = [
  "subscription_status",
  "subscription_tier",
  "payfast_subscription_token",
  "next_billing_date",
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const GHL_API_KEY = process.env.GHL_API_KEY;
  const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

  try {
    const { oldOwnerEmail, newOwnerEmail } = req.body;

    console.log("🔄 Ownership migration request received:", { oldOwnerEmail, newOwnerEmail });

    if (!oldOwnerEmail || !newOwnerEmail) {
      return res.status(400).json({ error: "Missing required field: oldOwnerEmail or newOwnerEmail" });
    }

    // — Step 1: Find both GHL contacts ---------------------------------------
    const oldContact = await findGHLContact(oldOwnerEmail, GHL_API_KEY, GHL_LOCATION_ID);
    if (!oldContact) {
      console.error("❌ No GHL contact found for old owner:", oldOwnerEmail);
      return res.status(404).json({ error: "Previous owner not found in GHL" });
    }

    const newContact = await findGHLContact(newOwnerEmail, GHL_API_KEY, GHL_LOCATION_ID);
    if (!newContact) {
      console.error("❌ No GHL contact found for new owner:", newOwnerEmail);
      return res.status(404).json({ error: "New owner not found in GHL" });
    }

    console.log(`✅ Found both contacts: old=${oldContact.id}, new=${newContact.id}`);

    // — Step 2: Extract subscription fields from the old owner's contact -----
    // GHL's contact READ API only ever returns custom fields as {id, value}
    // — never {key, value} — so we resolve values by known field ID where
    // possible, and fall back to UUID-shape matching for the token
    // (consistent with the approach proven reliable in cancel-subscription.js
    // and sync-tier-to-payfast.js).
    const oldCustomFields = oldContact.customFields || [];

    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const tokenField = oldCustomFields.find(
      (f) => typeof f.value === "string" && UUID_PATTERN.test(f.value)
    );

    // Known GHL field IDs for the Azanco location — confirmed via debug
    // logging on 7-8 July 2026, same as used in check-subscription.js.
    // Location-wide (same field = same ID across every contact), so safe
    // to reuse here rather than guessing which date field is which.
    const TRIAL_ENDS_AT_FIELD_ID = "xLH9TyB1bAc5dBMEX2PD";
    const NEXT_BILLING_DATE_FIELD_ID = "d7T5YIxFSwX3wBs2gpDm";

    const nextBillingDateField = oldCustomFields.find(
      (f) => f.id === NEXT_BILLING_DATE_FIELD_ID && typeof f.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.value)
    );

    const statusField = oldCustomFields.find(
      (f) => typeof f.value === "string" && ["trial", "active", "grace", "locked", "cancelled"].includes(f.value)
    );

    const tierField = oldCustomFields.find((f) => {
      const val = Array.isArray(f.value) ? f.value[0] : f.value;
      return typeof val === "string" && /^tier_?[123]$/.test(val);
    });

    const migratedData = {
      subscription_status: statusField?.value || null,
      subscription_tier: Array.isArray(tierField?.value) ? tierField.value[0] : tierField?.value || null,
      payfast_subscription_token: tokenField?.value || null,
      next_billing_date: nextBillingDateField?.value || null,
    };

    console.log("📋 Extracted from old owner's contact:", migratedData);

    // — Step 3: Write those fields onto the new owner's contact --------------
    const fieldsToWrite = Object.entries(migratedData).filter(([, value]) => value !== null);

    if (fieldsToWrite.length === 0) {
      console.warn("⚠️ No subscription fields found on old owner's contact — nothing to migrate.");
      return res.status(200).json({
        success: true,
        message: "No subscription fields found on previous owner's contact. Nothing migrated — please verify manually.",
        oldContactId: oldContact.id,
        newContactId: newContact.id,
      });
    }

    await updateGHLContact(
      newContact.id,
      Object.fromEntries(fieldsToWrite),
      GHL_API_KEY
    );

    console.log(`✅ Migrated ${fieldsToWrite.length} field(s) to new owner's contact ${newContact.id}`);

    return res.status(200).json({
      success: true,
      message: `Migrated subscription data from ${oldOwnerEmail} to ${newOwnerEmail}.`,
      oldContactId: oldContact.id,
      newContactId: newContact.id,
      migratedFields: Object.fromEntries(fieldsToWrite),
    });
  } catch (err) {
    console.error("❌ Ownership migration error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
}

// ---------------------------------------------------------------------------
// Helper: find GHL contact by email (same pattern as other Azanco endpoints)
// ---------------------------------------------------------------------------
async function findGHLContact(email, apiKey, locationId) {
  const url = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${locationId}&email=${encodeURIComponent(email)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: "2021-07-28",
    },
  });
  if (!response.ok) {
    console.error("GHL contact search failed:", await response.text());
    return null;
  }
  const data = await response.json();
  const found = data.contact;
  if (!found) return null;
  if (found.email?.toLowerCase() !== email.toLowerCase()) return null;
  return found;
}

// ---------------------------------------------------------------------------
// Helper: update GHL contact custom fields
// ---------------------------------------------------------------------------
async function updateGHLContact(contactId, fieldsObj, apiKey) {
  const customField = Object.entries(fieldsObj)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({ key, field_value: value }));

  const response = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ customFields: customField }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("GHL contact update failed:", errText);
    throw new Error("Failed to update GHL contact");
  }
  return response.json();
}
