// api/revert-discount-price.js - Vercel Serverless Function
// Called by the GHL workflow "Azanco — Discount Period Ended" when a
// client's temporary discount period expires. Reverts their PayFast
// subscription price back to a standard tier.
//
// IMPORTANT: this endpoint expects ownerEmail and revertTier to be passed
// DIRECTLY in the webhook body by the GHL workflow (using merge fields like
// {{contact.email}} and {{contact.discount_revert_tier}}) — it does NOT try
// to read discount_revert_tier back off the contact record itself, because
// GHL's read API returns custom fields keyed by internal ID rather than by
// name, and guessing/hardcoding that ID has been a recurring source of bugs
// elsewhere in this project. Passing the values through the webhook body
// sidesteps that problem entirely.
//
// UPDATE (3 Sept 2026): revertTier from the webhook is now only a FALLBACK.
// If the client upgraded tiers at any point during their discounted period,
// their subscription_tier custom field will reflect that — and blindly
// reverting to the tier that was guessed when the discount was first created
// would silently undo their upgrade. So this file now checks their CURRENT
// subscription_tier first (by field ID — confirmed 3 Sept 2026 via debug
// logging: Tir7pwVADQwH6NaZ15oP, a Dropdown-multiple field returned as an
// array, e.g. ["tier2"]) and only falls back to the webhook's revertTier if
// subscription_tier is empty. Note the value-format mismatch: subscription_tier
// stores "tier1"/"tier2"/"tier3" (no underscore), while discount_revert_tier
// and TIER_AMOUNTS use "tier_1"/"tier_2"/"tier_3" (with underscore) — both
// get normalised to the underscore format below before use.
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

// subscription_tier's internal GHL field ID — found via debug logging on
// 3 Sept 2026. Same landmine as trial_end_at: GHL's contact-search API
// returns custom fields keyed by this ID, never by name.
const SUBSCRIPTION_TIER_FIELD_ID = 'Tir7pwVADQwH6NaZ15oP';

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
    // — Step 1b: Prefer their CURRENT tier over the frozen webhook value -------
    const liveTier = getCurrentSubscriptionTier(contact);
    const effectiveTier = liveTier || normalizeTierValue(revertTier);
    console.log(`ℹ️ Tier resolution for ${ownerEmail}: live=${liveTier || 'none'}, webhook=${revertTier || 'none'}, using=${effectiveTier || 'none'}`);
    const newAmount = TIER_AMOUNTS[effectiveTier];
    if (!newAmount) {
      return res.status(400).json({
        error: `Could not resolve a valid tier to revert to (live="${liveTier}", webhook="${revertTier}"). Must resolve to one of: ${Object.keys(TIER_AMOUNTS).join(', ')}`,
      });
    }
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
    console.log(`✅ PayFast subscription ${subscriptionToken} reverted to R${newAmount}/month (${effectiveTier}).`);
    // — Step 4: Update GHL to reflect the new standard tier ---------------------
    await updateGHLContact(contactId, { subscription_tier: effectiveTier }, GHL_API_KEY);
    console.log(`✅ GHL subscription_tier updated to '${effectiveTier}' for contact ${contactId}.`);
    return res.status(200).json({
      success: true,
      message: `Discount ended — subscription reverted to ${effectiveTier} (R${newAmount}/month).`,
      contactId,
      subscriptionToken,
      tierSource: liveTier ? 'live subscription_tier' : 'webhook revertTier fallback',
    });
  } catch (err) {
    console.error('❌ Discount revert error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
// ---------------------------------------------------------------------------
// Helper: normalise a tier value to the underscore format ("tier_1") used by
// TIER_AMOUNTS — subscription_tier stores it WITHOUT the underscore
// ("tier1"), while discount_revert_tier stores it WITH ("tier_1").
// ---------------------------------------------------------------------------
function normalizeTierValue(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  const map = {
    tier1: 'tier_1', tier_1: 'tier_1',
    tier2: 'tier_2', tier_2: 'tier_2',
    tier3: 'tier_3', tier_3: 'tier_3',
  };
  return map[v] || null;
}
// ---------------------------------------------------------------------------
// Helper: read the contact's CURRENT subscription_tier by its known field ID
// (a Dropdown-multiple field, so its value comes back as an array).
// ---------------------------------------------------------------------------
function getCurrentSubscriptionTier(contact) {
  const field = (contact.customFields || []).find((f) => f.id === SUBSCRIPTION_TIER_FIELD_ID);
  if (!field) return null;
  const raw = Array.isArray(field.value) ? field.value[0] : field.value;
  return normalizeTierValue(raw);
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
