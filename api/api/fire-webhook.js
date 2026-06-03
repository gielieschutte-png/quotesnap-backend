// api/fire-webhook.js - Vercel Serverless Function
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
    const { webhookUrl, event, quoteData } = req.body;

    if (!webhookUrl || !event || !quoteData) {
      return res.status(400).json({ error: 'Missing required fields: webhookUrl, event, quoteData' });
    }

    // Prepare webhook payload
    const payload = {
      event: event, // "quote.created", "quote.sent", "quote.accepted"
      quote_id: quoteData.quote_id,
      quote_number: quoteData.quote_number,
      client_name: quoteData.client_name,
      client_email: quoteData.client_email,
      total: quoteData.total,
      status: quoteData.status,
      timestamp: new Date().toISOString()
    };

    // Fire webhook to external URL (e.g., GoHighLevel)
    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 10000 // 10 second timeout
    });

    const responseText = await webhookResponse.text();

    console.log(`✅ Webhook fired (${event}):`, webhookUrl, 'Status:', webhookResponse.status);

    return res.status(200).json({ 
      success: true, 
      message: 'Webhook fired successfully',
      webhookStatus: webhookResponse.status,
      event: event
    });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    // Don't fail if webhook fails - it's not critical
    return res.status(200).json({ 
      success: false, 
      message: 'Webhook firing failed',
      details: error.message,
      note: 'This is non-critical - quote was still created'
    });
  }
}
