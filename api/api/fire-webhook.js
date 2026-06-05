//fire-webhook.js - Vercel Serverless Function
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

    console.log('📥 Webhook request received:', { webhookUrl, event, quoteData });

    if (!webhookUrl || !event || !quoteData) {
      console.error('❌ Missing fields:', { webhookUrl, event, quoteData });
      return res.status(400).json({ error: 'Missing required fields: webhookUrl, event, quoteData' });
    }

    // Prepare webhook payload
    const payload = {
      event: event,
      quote_id: quoteData.quote_id,
      quote_number: quoteData.quote_number,
      client_name: quoteData.client_name,
      client_email: quoteData.client_email,
      total: quoteData.total,
      status: quoteData.status,
      timestamp: new Date().toISOString()
    };

    console.log('🚀 Firing webhook to:', webhookUrl);
    console.log('📦 Payload:', JSON.stringify(payload));

    // Proper timeout using AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const responseText = await webhookResponse.text();
    console.log(`✅ Webhook fired (${event}) - Status: ${webhookResponse.status} - Response: ${responseText}`);

    return res.status(200).json({ 
      success: true, 
      message: 'Webhook fired successfully',
      webhookStatus: webhookResponse.status,
      webhookResponse: responseText,
      event: event
    });

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('⏱️ Webhook timed out after 10 seconds');
      return res.status(200).json({ 
        success: false, 
        message: 'Webhook timed out',
        note: 'Non-critical - quote action was still completed'
      });
    }
    console.error('❌ Webhook error:', error.message);
    return res.status(200).json({ 
      success: false, 
      message: 'Webhook firing failed',
      details: error.message,
      note: 'Non-critical - quote action was still completed'
    });
  }
}
