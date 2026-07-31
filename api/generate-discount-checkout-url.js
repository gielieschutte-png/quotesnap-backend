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
    const { adminSecret, clientEmail, amount, description } = req.body;

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

    return res.status(200).json({ url: checkoutUrl, amount: formattedAmount, clientEmail });
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
