// /api/payfast-webhook.js
// Azanco — PayFast ITN Webhook
// Receives payment notifications from PayFast, validates them, updates GHL contact fields.

const crypto = require("crypto");
const https = require("https");
const querystring = require("querystring");

// ── Environment variables (set these in Vercel dashboard) ──────────────────
const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;
const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// ── NEW: Sandbox/Live mode switch ───────────────────────────────────────────
// Set PAYFAST_MODE=sandbox in Vercel env vars while testing.
// Leave unset (or set to anything else) in production to use the live server.
const PAYFAST_MODE = process.env.PAYFAST_MODE; // "sandbox" or unset/"live"
const PAYFAST_VERIFY_HOST =
  PAYFAST_MODE === "sandbox" ? "sandbox.payfast.co.za" : "www.payfast.co.za";

// ── GHL custom field keys ──────────────────────────────────────────────────
const GHL_FIELDS = {
  subscription_status: "subscription_status",
  subscription_tier: "subscription_tier",
  next_billing_date: "next_billing_date",
  trial_ends_at: "trial_ends_at",
};

// ── Tier mapping by amount (ZAR) ───────────────────────────────────────────
function getTierFromAmount(amount) {
  const num = parseFloat(amount);
  if (num >= 3500) return "tier_3";
  if (num >= 2600) return "tier_2";
  return "tier_1";
}

// ── Calculate next billing date (1 month from today) ──────────────────────
function getNextBillingDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

// ── PayFast ITN signature validation ──────────────────────────────────────
function validateSignature(data, receivedSignature) {
  // Remove signature from data before hashing
  const { signature, ...rest } = data;

  // Build query string in the order PayFast sends fields
  const paramString = Object.keys(rest)
    .map((key) => `${key}=${encodeURIComponent(rest[key]).replace(/%20/g, "+")}`)
    .join("&");

  // Append the PASSPHRASE (not the merchant key) — this is the correct PayFast spec
  const withPassphrase = `${paramString}&passphrase=${encodeURIComponent(
    PAYFAST_PASSPHRASE
  ).replace(/%20/g, "+")}`;

  const hash = crypto.createHash("md5").update(withPassphrase).digest("hex");
  return hash === receivedSignature;
}

// ── Verify ITN with PayFast servers (they confirm it's real) ───────────────
// NOTE: now uses PAYFAST_VERIFY_HOST so sandbox transactions verify against
// PayFast's sandbox server instead of the live one.
function verifyWithPayFast(rawBody) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: PAYFAST_VERIFY_HOST,
      port: 443,
      path: "/eng/query/validate",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(rawBody),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body.trim() === "VALID"));
    });

    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

// ── Find GHL contact by email ──────────────────────────────────────────────
async function findGHLContact(email) {
  const url = `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: "2021-07-28",
    },
  });

  const { data, error } = await res.json().then(
    (d) => ({ data: d, error: null }),
    (e) => ({ data: null, error: e })
  );

  if (error || !data?.contacts?.length) return null;
  return data.contacts[0];
}

// ── Update GHL contact custom fields ──────────────────────────────────────
async function updateGHLContact(contactId, fields) {
  const customFields = Object.entries(fields).map(([key, value]) => ({
    key,
    field_value: value,
  }));

  const res = await fetch(
    `https://services.leadconnectorhq.com/contacts/${contactId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ customFields }),
    }
  );

  const { data, error } = await res.json().then(
    (d) => ({ data: d, error: null }),
    (e) => ({ data: null, error: e })
  );

  if (error) throw new Error(`GHL update failed: ${JSON.stringify(error)}`);
  return data;
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const data = req.body; // Vercel parses urlencoded body automatically

    // 1. Validate merchant ID matches ours
    if (data.merchant_id !== PAYFAST_MERCHANT_ID) {
      console.error("Merchant ID mismatch");
      return res.status(400).send("Invalid merchant");
    }

    // 2. Validate signature (uses PAYFAST_PASSPHRASE correctly)
    const signatureValid = validateSignature(data, data.signature);
    if (!signatureValid) {
      console.error("Signature validation failed");
      return res.status(400).send("Invalid signature");
    }

    // 3. Verify with PayFast servers (sandbox or live, depending on PAYFAST_MODE)
    const rawBody = querystring.stringify(data);
    const isValid = await verifyWithPayFast(rawBody);
    if (!isValid) {
      console.error(`PayFast server verification failed (mode: ${PAYFAST_MODE || "live"})`);
      return res.status(400).send("PayFast verification failed");
    }

    // 4. Extract key fields
    // NOTE: lookupEmail now comes from custom_str1 — the hidden passthrough
    // field we set on checkout — NOT email_address, which the payer can edit
    // on PayFast's page before paying.
    const {
      payment_status,
      amount_gross,
      email_address, // kept for logging only, no longer used for lookup
      m_payment_id,
      custom_str1,
    } = data;

    const lookupEmail = custom_str1;

    console.log(
      `PayFast ITN received: status=${payment_status}, amount=${amount_gross}, ` +
      `payer_email=${email_address}, lookup_email(custom_str1)=${lookupEmail}, mode=${PAYFAST_MODE || "live"}`
    );

    if (!lookupEmail) {
      console.error("No custom_str1 (lookup email) present on ITN — cannot match a GHL contact");
      return res.status(200).send("OK");
    }

    // 5. Find the GHL contact by the custom_str1 email (not the editable payer email)
    const contact = await findGHLContact(lookupEmail);
    if (!contact) {
      console.error(`No GHL contact found for email: ${lookupEmail}`);
      return res.status(200).send("OK");
    }

    const contactId = contact.id;
    const tier = getTierFromAmount(amount_gross);

    // 6. Handle each payment status
    if (payment_status === "COMPLETE") {
      await updateGHLContact(contactId, {
        [GHL_FIELDS.subscription_status]: "active",
        [GHL_FIELDS.subscription_tier]: tier,
        [GHL_FIELDS.next_billing_date]: getNextBillingDate(),
      });
      console.log(`Contact ${contactId} activated on ${tier}`);

    } else if (payment_status === "FAILED") {
      await updateGHLContact(contactId, {
        [GHL_FIELDS.subscription_status]: "grace",
      });
      console.log(`Contact ${contactId} moved to grace (payment failed)`);

    } else if (payment_status === "CANCELLED") {
      await updateGHLContact(contactId, {
        [GHL_FIELDS.subscription_status]: "locked",
      });
      console.log(`Contact ${contactId} locked (subscription cancelled)`);

    } else {
      console.log(`Unhandled payment_status: ${payment_status}`);
    }

    return res.status(200).send("OK");

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("OK");
  }
}
