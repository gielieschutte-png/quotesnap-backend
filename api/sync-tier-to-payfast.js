// api/sync-tier-to-payfast.js - Vercel Serverless Function
//
// Closes the gap identified 7-8 July 2026: when a company's subscription_tier
// changes in GHL (e.g. a 4th team member joins), nothing previously told
// PayFast to actually change the billed amount — PayFast kept charging the
// original tier's price indefinitely. This endpoint calls PayFast's
// Recurring Billing /update API to fix that.
//
// Called with: POST { ownerEmail: string, newTier: "tier_1" | "tier_2" | "tier_3" }
//
// NOT YET WIRED UP to anything that calls it automatically — this is the
// backend piece only. Still needed: something in Base44 (the confirm-to-
// upgrade prompt) or a GHL workflow that actually triggers this endpoint
// when a tier change happens.

import crypto from 'crypto';

// Single source of truth for tier pricing (ZAR, matches payfast-webhook.js
// and the Base44 checkout links). Keep this in sync if pricing changes.
const TIER_AMOUNTS = {
  tier_1: '1746.00',
  tier_2: '2700.00',
  tier_3: '3600.00',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ownerEmail, newTier } = req.body;

    console.log('🔄 Tier sync request received:', { ownerEmail, newTier });

    if (!ownerEmail || !newTier) {
      return res.status(400).json({ error: 'Missing required field: ownerEmail or newTier' });
    }

    const newAmount = TIER_AMOUNTS[newTier];
    if (!newAmount) {
      return res.status(400).json({
        error: `Unrecognised tier "${newTier}". Must be one of: ${Object.keys(TIER_AMOUNTS).join(', ')}`,
      });
    }

    const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
    const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE;
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
    const isSandbox = process.env.PAYFAST_MODE === 'sandbox';

    // — Step 1: Find the GHL contact by owner email --------------------------
    const contact = await findGHLContact(ownerEmail, GHL_API_KEY, GHL_LOCATION_ID);
    if (!contact) {
      console.error('❌ No GHL contact found for:', ownerEmail);
      return res.status(404).json({ error: 'Contact not found in GHL' });
    }
    const contactId = contact.id;

    // — Step 2: Extract the PayFast subscription token ------------------------
    // Matches by UUID shape rather than internal field ID — confirmed the
    // more reliable approach on 7 July 2026 after ID-matching silently failed.
    const customFields = contact.customFields || [];
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const tokenField = customFields.find(
      (f) => typeof f.value === 'string' && UUID_PATTERN.test(f.value)
    );
    const subscriptionToken = tokenField?.value;

    if (!subscriptionToken) {
      console.error('❌ No payfast_subscription_token found for contact:', contactId);
      return res.status(400).json({
        error: 'No active PayFast subscription token found for this account.',
      });
    }

    console.log('✅ Found subscription token:', subscriptionToken);

    // — Step 3: Update the PayFast subscription's billed amount --------------
    const payfastResult = await updatePayFastSubscription(
      subscriptionToken,
      PAYFAST_MERCHANT_ID,
      PAYFAST_PASSPHRASE,
      newAmount,
      isSandbox
    );

    if (!payfastResult.success) {
      console.error('❌ PayFast update failed:', payfastResult.error);
      return res.status(502).json({
        error: 'PayFast subscription update failed. No GHL changes made.',
        details: payfastResult.error,
      });
    }

    console.log(`✅ PayFast subscription ${subscriptionToken} updated to R${newAmount}/month.`);

    // — Step 4: Confirm subscription_tier in GHL matches (idempotent write) --
    await updateGHLContact(contactId, { subscription_tier: newTier }, GHL_API_KEY);
    console.log(`✅ GHL subscription_tier confirmed as '${newTier}' for contact ${contactId}.`);

    return res.status(200).json({
      success: true,
      message: `Subscription updated to ${newTier} (R${newAmount}/month).`,
      contactId,
      subscriptionToken,
    });
  } catch (err) {
    console.error('❌ Tier sync error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}

// ---------------------------------------------------------------------------
// Helper: find GHL contact by email (same pattern as cancel-subscription.js)
// ---------------------------------------------------------------------------
async function findGHLContact(email, apiKey, locationId) {
  const url = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${locationId}&email=${encodeURIComponent(email)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: '2021-07-28',
    },
  });
  if (!response.ok) {
    console.error('GHL contact search failed:', await response.text());
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
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ({ key, field_value: value }));

  const response = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ customFields: customField }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('GHL contact update failed:', errText);
    throw new Error('Failed to update GHL contact');
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Helper: update a PayFast subscription's billed amount
//
// IMPORTANT: unlike the checkout link's `amount` (decimal Rand, e.g.
// "1746.00"), the Recurring Billing API's `amount` field is in CENTS with
// no decimal point (e.g. 174600). Confirmed directly from PayFast's API docs.
//
// IMPORTANT: unlike /cancel (no body), /update sends a body — and PayFast's
// signature must include the alphabetised BODY fields together with the
// header fields, not headers alone.
// ---------------------------------------------------------------------------
async function updatePayFastSubscription(token, merchantId, passphrase, newAmountRand, isSandbox) {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const version = 'v1';

    // Convert Rand (e.g. "2700.00") to cents (e.g. "270000") for the API.
    const amountCents = String(Math.round(parseFloat(newAmountRand) * 100));

    const bodyParams = { amount: amountCents };

    // Alphabetised: amount, merchant-id, passphrase, timestamp, version
    const allParams = {
      'merchant-id': merchantId,
      passphrase: passphrase,
      timestamp: timestamp,
      version: version,
      ...bodyParams,
    };

    const sortedKeys = Object.keys(allParams).sort();
    const signatureInput = sortedKeys
      .map((k) => `${k}=${encodeURIComponent(allParams[k]).replace(/%20/g, '+')}`)
      .join('&');

    const signature = crypto.createHash('md5').update(signatureInput).digest('hex').toLowerCase();

    console.log('PayFast update signature input:', signatureInput);

    const url = `https://api.payfast.co.za/subscriptions/${token}/update${isSandbox ? '?testing=true' : ''}`;
    console.log('PayFast update URL:', url);

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'merchant-id': merchantId,
        version,
        timestamp,
        signature,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyParams),
    });

    const responseData = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { success: false, error: responseData?.message || `PayFast returned status ${response.status}` };
    }

    return { success: true, data: responseData };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
