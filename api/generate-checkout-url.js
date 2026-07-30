// api/generate-checkout-url.js - Vercel Serverless Function
// Generates a SIGNED PayFast checkout URL server-side.
// Called from SubscriptionBanner.jsx and SubscriptionLockedScreen.jsx
// instead of building the checkout URL directly in the browser.
//
// WHY THIS EXISTS: Previously, SubscriptionBanner.jsx and
// SubscriptionLockedScreen.jsx built the PayFast checkout URL entirely in
// the browser, with no signature. Anyone could open dev tools, edit the
// "amount" query parameter in that URL, and PayFast would accept the
// tampered amount with no way to detect it. This endpoint fixes that by:
//   1. Looking up the price SERVER-SIDE from a fixed tier code
//      (the browser can request "tier1", but can never supply its own amount)
//   2. Signing the final set of parameters with PayFast's passphrase,
//      which lives only in this server's environment variables and is
//      never sent to the browser
//   3. Returning the complete, signed URL for the browser to redirect to
//
// If someone edits the amount in the resulting URL after receiving it,
// the signature will no longer match and PayFast will reject the payment.

import crypto from 'crypto';

// Server-side source of truth for pricing. The browser only ever sends
// a tier CODE (e.g. "tier1"), never an amount.
const TIERS = {
  tier1: { amount: '1746.00', itemName: 'Azanco Tier 1', members: 'Up to 3 team members' },
  tier2: { amount: '2700.00', itemName: 'Azanco Tier 2', members: 'Up to 7 team members' },
  tier3: { amount: '3600.00', itemName: 'Azanco Tier 3', members: 'Unlimited team members' },
};

// PayFast's checkout (redirect) signature uses THIS FIXED FIELD ORDER —
// not alphabetical. This is different from the Recurring Billing API
// signature used in cancel-subscription.js, which IS alphabetised.
// Per developers.payfast.co.za/docs#step_2_signature
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
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { tierCode, ownerEmail } = req.body;

    if (!tierCode || !TIERS[tierCode]) {
      return res.status(400).json({ error: 'Invalid or missing tierCode. Must be one of: tier1, tier2, tier3' });
    }
    if (!ownerEmail) {
      return res.status(400).json({ error: 'Missing required field: ownerEmail' });
    }

    const tier = TIERS[tierCode];

    const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID;
    const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY;
    const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE;

    if (!PAYFAST_MERCHANT_ID || !PAYFAST_MERCHANT_KEY || !PAYFAST_PASSPHRASE) {
      console.error('❌ Missing PayFast environment variables');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Build the full parameter set — amount comes ONLY from the server-side
    // TIERS lookup above, never from the request body.
    const params = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: 'https://quote.azanco.app/settings?subscribed=true',
      cancel_url: 'https://quote.azanco.app/settings',
      notify_url: 'https://quotesnap-backend-v2.vercel.app/api/payfast-webhook',
      amount: tier.amount,
      item_name: `${tier.itemName} (${tier.members}) - ${ownerEmail}`,
      custom_str1: ownerEmail,
      subscription_type: '1',
      recurring_amount: tier.amount,
      frequency: '3',
      cycles: '0',
    };

    const signature = generateCheckoutSignature(params, PAYFAST_PASSPHRASE);

    // Built manually with phpStyleEncode (NOT URLSearchParams) so the
    // submitted query string uses the exact same encoding as the signed
    // string above — URLSearchParams encodes a couple of characters
    // (like '*') differently than PHP's urlencode, which previously caused
    // "signature does not match" errors on PayFast's side.
    const allParams = { ...params, signature };
    const checkoutUrl = `https://www.payfast.co.za/eng/process?${CHECKOUT_SIGNATURE_FIELD_ORDER
      .filter((key) => allParams[key] !== undefined && allParams[key] !== null && allParams[key] !== '')
      .map((key) => `${key}=${phpStyleEncode(allParams[key])}`)
      .concat(`signature=${phpStyleEncode(allParams.signature)}`)
      .join('&')}`;

    console.log(`✅ Generated signed checkout URL for ${ownerEmail}, tier ${tierCode}`);

    return res.status(200).json({ url: checkoutUrl });
  } catch (err) {
    console.error('❌ generate-checkout-url error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}

// ---------------------------------------------------------------------------
// PayFast checkout signature: MD5 of params in CHECKOUT_SIGNATURE_FIELD_ORDER
// (only fields that are actually present), URL-encoded with uppercase hex
// escapes and spaces as '+', passphrase appended at the end, all lowercase.
//
// IMPORTANT: PayFast's server is PHP-based and encodes/re-checks using PHP's
// urlencode(), which escapes a handful of characters that JS's
// encodeURIComponent() does NOT escape by default: ( ) ! * '
// If item_name or any other field contains these (e.g. "Tier 1 (Up to 3
// team members)"), a plain encodeURIComponent produces a DIFFERENT string
// than PayFast recomputes on their end, causing "signature does not match"
// — even though the signature logic and field order are otherwise correct.
// phpStyleEncode() below patches encodeURIComponent to match PHP exactly.
// ---------------------------------------------------------------------------
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
