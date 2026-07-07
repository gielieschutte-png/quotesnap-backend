// api/cancel-subscription.js - Vercel Serverless Function
// Cancels a PayFast subscription and updates GHL to reflect cancellation.
// Called from Base44 CancelSubscriptionCard when an Owner confirms cancellation.

import crypto from 'crypto';

export default async function handler(req, res) {
  // Handle CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { ownerEmail, cancellationReason } = req.body;

    console.log('🚫 Cancellation request received:', { ownerEmail, cancellationReason });

    if (!ownerEmail) {
      console.error('❌ Missing field: ownerEmail');
      return res.status(400).json({ error: 'Missing required field: ownerEmail' });
    }

    // — Environment variables ---------------------------------------------
    const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
    const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE;
    const GHL_API_KEY = process.env.GHL_API_KEY;
    const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

    // — GHL custom field keys (used when WRITING — GHL resolves key -> id
    // correctly on PUT requests, this part already works fine) -----------
    const GHL_FIELDS = {
      subscription_status: 'subscription_status',
      subscription_tier: 'subscription_tier',
      next_billing_date: 'next_billing_date',
      trial_ends_at: 'trial_ends_at',
      payfast_subscription_token: 'payfast_subscription_token',
      cancellation_reason: 'cancellation_reason',
    };

    // GHL's contact READ API only ever returns custom fields as
    // {id, value} — never {key, value} — confirmed via debug logging on
    // 7 July 2026. Matching by internal ID proved unreliable (likely a
    // visually-identical character mismatch, e.g. '1' vs 'l', introduced
    // when manually copying the ID). Instead, we match by VALUE SHAPE:
    // PayFast subscription tokens are always UUID-formatted
    // (8-4-4-4-12 hex characters), and no other Azanco custom field uses
    // that shape — so this is both simpler and immune to the field being
    // deleted/recreated in future (unlike matching by internal ID).
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Confirmed correct as of 7 July 2026, verified directly against GHL's
    // live pipeline API response.
    const CANCELLED_STAGE_ID = '9c788839-7a33-4d45-ba7c-0868fd7636e7';
    const PIPELINE_ID = 'OockSDqNecRfQul2RhxH'; // Azanco Signup pipeline

    // — Step 1: Find the GHL contact by owner email ------------------------
    const contact = await findGHLContact(ownerEmail, GHL_API_KEY, GHL_LOCATION_ID);
    if (!contact) {
      console.error('❌ No GHL contact found for:', ownerEmail);
      return res.status(404).json({ error: 'Contact not found in GHL' });
    }
    const contactId = contact.id;

    // — Step 2: Extract the stored PayFast subscription token --------------
    const customFields = contact.customFields || [];
    const tokenField = customFields.find(
      (f) => typeof f.value === 'string' && UUID_PATTERN.test(f.value)
    );
    const subscriptionToken = tokenField?.value;

    if (!subscriptionToken) {
      console.error('❌ No payfast_subscription_token found for contact:', contactId);
      return res.status(400).json({
        error: 'No active PayFast subscription token found for this account. Cannot cancel automatically — may need manual handling.',
      });
    }

    console.log('✅ Found subscription token:', subscriptionToken);

    // — Step 3: Cancel the PayFast subscription -----------------------------
    const payfastResult = await cancelPayFastSubscription(
      subscriptionToken,
      PAYFAST_MERCHANT_ID,
      PAYFAST_PASSPHRASE
    );

    if (!payfastResult.success) {
      console.error('❌ PayFast cancellation failed:', payfastResult.error);
      return res.status(502).json({
        error: 'PayFast cancellation failed. No GHL changes made.',
        details: payfastResult.error,
      });
    }

    console.log(`✅ PayFast subscription ${subscriptionToken} cancelled successfully.`);

    // — Step 4: Update GHL contact custom fields ----------------------------
    await updateGHLContact(contactId, {
      [GHL_FIELDS.subscription_status]: 'cancelled',
      [GHL_FIELDS.cancellation_reason]: cancellationReason || 'Not specified',
    }, GHL_API_KEY);

    console.log(`✅ Contact ${contactId} subscription_status set to 'cancelled'.`);

    // — Step 5: Move the opportunity to the Cancelled pipeline stage --------
    const opportunity = await findOpportunityForContact(contactId, PIPELINE_ID, GHL_API_KEY, GHL_LOCATION_ID);
    if (opportunity) {
      await updateOpportunityStage(opportunity.id, CANCELLED_STAGE_ID, GHL_API_KEY);
      console.log(`✅ Opportunity ${opportunity.id} moved to Cancelled stage.`);
    } else {
      console.warn(`⚠️ No opportunity found for contact ${contactId} — pipeline stage not updated.`);
    }

    return res.status(200).json({
      success: true,
      message: 'Subscription cancelled successfully.',
      contactId,
    });
  } catch (err) {
    console.error('❌ Webhook error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}

// ---------------------------------------------------------------------------
// Helper: find GHL contact by email
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

  // Verify exact email match client-side (GHL search can be fuzzy)
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
// Helper: find the open opportunity for a contact within a pipeline
// ---------------------------------------------------------------------------
async function findOpportunityForContact(contactId, pipelineId, apiKey, locationId) {
  const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&contact_id=${contactId}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: '2021-07-28',
    },
  });
  if (!response.ok) {
    console.error('GHL opportunity search failed:', await response.text());
    return null;
  }
  const data = await response.json();
  const opportunities = data.opportunities || [];
  return opportunities[0] || null;
}

// ---------------------------------------------------------------------------
// Helper: move an opportunity to a new pipeline stage
// ---------------------------------------------------------------------------
async function updateOpportunityStage(opportunityId, stageId, apiKey) {
  const response = await fetch(`https://services.leadconnectorhq.com/opportunities/${opportunityId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pipelineStageId: stageId }),
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error('GHL opportunity stage update failed:', errText);
    throw new Error('Failed to update opportunity stage');
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Helper: cancel a PayFast subscription
// Signature = MD5 hash of the alphabetised header variables plus the
// passphrase, each value URL-encoded (spaces as '+'), all lowercase.
// Per: developers.payfast.co.za/api#cancel-a-subscription
// ---------------------------------------------------------------------------
async function cancelPayFastSubscription(token, merchantId, passphrase) {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const version = 'v1';

    const params = {
      'merchant-id': merchantId,
      passphrase: passphrase,
      timestamp: timestamp,
      version: version,
    };

    const sortedKeys = Object.keys(params).sort();
    const signatureInput = sortedKeys
      .map((k) => `${k}=${encodeURIComponent(params[k]).replace(/%20/g, '+')}`)
      .join('&');

    const signature = crypto.createHash('md5').update(signatureInput).digest('hex').toLowerCase();

    console.log('PayFast cancel signature input:', signatureInput);

    const response = await fetch(`https://api.payfast.co.za/subscriptions/${token}/cancel`, {
      method: 'PUT',
      headers: {
        'merchant-id': merchantId,
        version,
        timestamp,
        signature,
        'Content-Type': 'application/json',
      },
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
