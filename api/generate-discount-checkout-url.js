// api/generate-discount-checkout-url.js - Vercel Serverless Function
// Generates a SIGNED, custom-price PayFast checkout URL for individual
// marketing clients getting a discounted Azanco rate.
//
// Protected by ADMIN_SECRET (set in Vercel env vars) so only Machiel — via
// the admin page — can generate these links. Never exposed in the main app.
//
// Uses the exact same signing approach as generate-checkout-url.js
// (PHP-style encoding, fixed field order) — see that file for the full
// explanation of why plain encodeURIComponent isn't safe to use here.

import crypto from 'crypto';

const CHECKOUT_SIGNATURE_FIELD_ORDER = [
  'merchant_id',
  'merchant_key',
  'return_url',
  'cancel_url',
  'notify_url',
  'name_first',
  'name_last',
  'email_address',
  'cell_number',
  'm_payment_id',
  'amount',
  'item_name',
  'item_description',
  'custom_int1',
  'custom_int2',
  'custom_int3',
  'custom_int4',
  'custom_int5',
  'custom_str1',
  'custom_str2',
  'custom_str3',
  'custom_str4',
  'custom_str5',
  'email_confirmation',
  'confirmation_address',
  'payment_method',
  'subscription_type',
  'billing_date',
  'recurring_amount',
  'frequency',
  'cycles',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { adminSecret, clientEmail, amount, description, discountMonths, revertTier } = req.body;

    // --- Auth check: only someone with the admin secret can generate a
    // discount link. This is the ONLY thing standing between this endpoint
    // and anyone being able to mint arbitrary-price checkout links, so it
    // must be checked before anything else.
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'Not authorised' });
    }

    if (!clientEmail || !clientEmail.includes('@')) {
      return res.status(400).json({ error: 'Valid clientEmail is required' });
    }

    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0 || amountNum > 100000) {
      return res.status(400).json({ error: 'Amount must be a positive number (in Rands, e.g. 1322.00), under R100,000' });
    }
    const formattedAmount = amountNum.toFixed(2);

    const VALID_REVERT_TIERS = ['tier_1', 'tier_2', 'tier_3'];
    let discountNote = '';

    // --- If a discount duration was set, find the client's existing GHL
    // contact and write when the discount should end + what to revert to.
    // The client must already exist in GHL (i.e. have signed up for a
    // trial in the app) — this endpoint does NOT create new contacts.
    if (discountMonths) {
      const monthsNum = Number(discountMonths);
      if (!monthsNum || monthsNum <= 0 || !Number.isInteger(monthsNum)) {
        return res.status(400).json({ error: 'Discount months must be a whole number greater than 0' });
      }
      if (!revertTier || !VALID_REVERT_TIERS.includes(revertTier)) {
        return res.status(400).json({ error: 'A valid revertTier (tier_1, tier_2, or tier_3) is required when discountMonths is set' });
      }

      const GHL_API_KEY = process.env.GHL_API_KEY;
      const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

      const contact = await findGHLContact(clientEmail, GHL_API_KEY, GHL_LOCATION_ID);
      if (!contact) {
        return res.status(404).json({
          error: `No existing Azanco contact found for ${clientEmail}. They need to sign up for a trial in the app first, THEN you can generate a time-limited discount link for them.`,
        });
      }

      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + monthsNum);
      const endDateStr = endDate.toISOString().split('T')[0]; // YYYY-MM-DD

      await updateGHLContact(contact.id, {
        discount_end_date: endDateStr,
        discount_revert_tier: revertTier,
      }, GHL_API_KEY);

      discountNote = `Discount active for ${monthsNum} month${monthsNum !== 1 ? 's' : ''}, then auto-reverts to ${revertTier.replace('_', ' ')} pricing on ${endDateStr}.`;
      console.log(`✅ Discount schedule set for ${clientEmail}: ends ${endDateStr}, reverts to ${revertTier}`);
    } else {
      discountNote = 'Indefinite discount — no automatic revert scheduled.';
    }

    const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
    const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;
    const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE;

    if (!PAYFAST_MERCHANT_ID || !PAYFAST_MERCHANT_KEY || !PAYFAST_PASSPHRASE) {
      console.error('❌ Missing PayFast environment variables');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const params = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: 'https://quote.azanco.app/settings?subscribed=true',
      cancel_url: 'https://quote.azanco.app/settings',
      notify_url: 'https://quotesnap-backend-v2.vercel.app/api/payfast-webhook',
      amount: formattedAmount,
      item_name: description
        ? `Azanco - ${description} - ${clientEmail}`
        : `Azanco - Special Rate - ${clientEmail}`,
      custom_str1: clientEmail,
      subscription_type: '1',
      recurring_amount: formattedAmount,
      frequency: '3', // monthly
      cycles: '0', // bill indefinitely until cancelled
    };

    const signature = generateCheckoutSignature(params, PAYFAST_PASSPHRASE);

    const allParams = { ...params, signature };
    const checkoutUrl = `https://www.payfast.co.za/eng/process?${CHECKOUT_SIGNATURE_FIELD_ORDER
      .filter((key) => allParams[key] !== undefined && allParams[key] !== null && allParams[key] !== '')
      .map((key) => `${key}=${phpStyleEncode(allParams[key])}`)
      .concat(`signature=${phpStyleEncode(allParams.signature)}`)
      .join('&')}`;

    console.log(`✅ Generated discount checkout URL for ${clientEmail} at R${formattedAmount}/month`);

    return res.status(200).json({ url: checkoutUrl, amount: formattedAmount, clientEmail, discountNote });
  } catch (err) {
    console.error('❌ generate-discount-checkout-url error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}

function phpStyleEncode(value) {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function generateCheckoutSignature(params, passphrase) {
  const orderedPairs = CHECKOUT_SIGNATURE_FIELD_ORDER
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map((key) => `${key}=${phpStyleEncode(params[key])}`);

  orderedPairs.push(`passphrase=${phpStyleEncode(passphrase)}`);

  const signatureInput = orderedPairs.join('&');

  return crypto.createHash('md5').update(signatureInput).digest('hex').toLowerCase();
}

// ---------------------------------------------------------------------------
// Helper: find GHL contact by email — same proven pattern as
// cancel-subscription.js / sync-tier-to-payfast.js
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
// Helper: update GHL contact custom fields — GHL resolves key -> internal ID
// correctly on PUT requests, so writing by key (not ID) is safe.
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
