// api/revert-discount-price.js - Vercel Serverless Function
// Called by the GHL workflow "Azanco — Discount Period Ended" when a
// client's temporary discount period expires. Reverts their PayFast
// subscription price back to a standard tier.
//
// IMPORTANT: this endpoint expects contactId, ownerEmail, and revertTier to
// be passed DIRECTLY in the webhook body by the GHL workflow (using merge
// fields like {{contact.email}} and {{contact.discount_revert_tier}}) —
// it does NOT try to read discount_revert_tier back off the contact record
// itself, because GHL's read API returns custom fields keyed by internal ID
// rather than by name, and guessing/hardcoding that ID has been a recurring
// source of bugs elsewhere in this project. Passing the values through the
// webhook body sidesteps that problem entirely.
//
// Reuses the exact PayFast /update signature logic already proven working
// in sync-tier-to-payfast.js (alphabetised header + body fields, amount in
// CENTS, PATCH method).

import crypto from 'crypto';

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
    const { ownerEmail, revertTier } = req.body;

    console.log('🔄 Discount revert request received:', { ownerEmail, revertTier });

    if (!ownerEmail) {
      return res.status(400).json({ error: 'Missing required field: ownerEmail' });
    }
    const newAmount = TIER_AMOUNTS[revertTier];
    if (!newAmount) {
      return res.status(400).json({
        error: `Unrecognised revertTier "${revertTier}". Must be one of: ${Object.keys(TIER_AMOUNTS).join(', ')}`,
      });
    }

    const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
    const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE;
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
    const isSandbox = process.env.PAYFAST_MODE === 'sandbox';

    // — Step 1: Find the GHL contact by owner email ---------------------------
    const contact = await findGHLContact(ownerEmail, GHL_API_KEY, GHL_LOCATION_ID);
    if (!contact) {
      console.error('❌ No GHL contact found for:', ownerEmail);
      return res.status(404).json({ error: 'Contact not found in GHL' });
    }
    const contactId = contact.id;

    // — Step 2: Extract the PayFast subscription token -------------------------
    // Matches by UUID shape, not internal field ID — the proven reliable
    // approach used throughout this project (see cancel-subscription.js).
    const customFields = contact.customFields || [];
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const tokenField = customFields.find(
      (f) => typeof f.value === 'string' && UUID_PATTERN.test(f.value)
    );
    const subscriptionToken = tokenField?.value;

    if (!subscriptionToken) {
      console.error('❌ No payfast_subscription_token found for contact:', contactId);
      return res.status(400).json({
        error: 'No active PayFast subscription token found for this account — cannot auto-revert. May need manual handling.',
      });
    }

    console.log('✅ Found subscription token:', subscriptionToken);

    // — Step 3: Update the PayFast subscription's billed amount ----------------
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
        error: 'PayFast subscription revert failed. No GHL changes made.',
        details: payfastResult.error,
      });
    }

    console.log(`✅ PayFast subscription ${subscriptionToken} reverted to R${newAmount}/month (${revertTier}).`);

    // — Step 4: Update GHL to reflect the new standard tier ---------------------
    await updateGHLContact(contactId, { subscription_tier: revertTier }, GHL_API_KEY);
    console.log(`✅ GHL subscription_tier updated to '${revertTier}' for contact ${contactId}.`);

    return res.status(200).json({
      success: true,
      message: `Discount ended — subscription reverted to ${revertTier} (R${newAmount}/month).`,
      contactId,
      subscriptionToken,
    });
  } catch (err) {
    console.error('❌ Discount revert error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}

// ---------------------------------------------------------------------------
// Helper: find GHL contact by email (same proven pattern used throughout)
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
// Helper: update a PayFast subscription's billed amount — EXACT same proven
// logic as sync-tier-to-payfast.js (amount in cents, PATCH, alphabetised
// header + body fields for signature).
// ---------------------------------------------------------------------------
async function updatePayFastSubscription(token, merchantId, passphrase, newAmountRand, isSandbox) {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const version = 'v1';
    const amountCents = String(Math.round(parseFloat(newAmountRand) * 100));
    const bodyParams = { amount: amountCents };

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

    const url = `https://api.payfast.co.za/subscriptions/${token}/update${isSandbox ? '?testing=true' : ''}`;

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
