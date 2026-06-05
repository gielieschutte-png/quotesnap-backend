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

    console.log('📥 Webhook request received:', { webhookUrl, event, quoteData });

    if (!webhookUrl || !event || !quoteData) {
      console.error('❌ Missing fields:', { webhookUrl, event, quoteData });
      return res.status(400).json({ error: 'Missing required fields: webhookUrl, event, quoteData' });
    }

    // Split client name into first and last name for GHL
    const nameParts = (quoteData.client_name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Build line items summary (readable text version)
    const lineItems = quoteData.line_items || [];
    const lineItemsSummary = lineItems.map(item =>
      `${item.service || item.name || 'Service'}: ${item.description || ''} | Qty: ${item.quantity || item.area_km || ''} | Rate: R${item.rate || 0} | Total: R${item.line_total || item.total || 0}`
    ).join('\n');

    // Full payload with ALL quote fields
    const payload = {
      // Event info
      event: event,
      timestamp: new Date().toISOString(),

      // Contact fields (split for GHL)
      first_name: firstName,
      last_name: lastName,
      client_name: quoteData.client_name || '',
      client_email: quoteData.client_email || '',
      client_phone: quoteData.client_phone || '',
      client_contact: quoteData.client_contact || '',

      // Quote / Invoice details
      quote_id: quoteData.quote_id || '',
      quote_number: quoteData.quote_number || '',
      doc_label: quoteData.doc_label || 'Quote',
      status: quoteData.status || '',
      quote_date: quoteData.quote_date || '',
      valid_until: quoteData.valid_until || '',
      job_reference: quoteData.job_reference || '',
      job_address: quoteData.job_address || '',
      vat_number: quoteData.vat_number || '',

      // Financial fields
      subtotal: quoteData.subtotal || 0,
      vat_amount: quoteData.vat_amount || 0,
      total: quoteData.total || 0,

      // Line items
      line_items: JSON.stringify(lineItems),
      line_items_summary: lineItemsSummary,

      // Notes and terms
      notes: quoteData.notes || '',
      banking_details: quoteData.banking_details || '',
      disclaimer: quoteData.disclaimer || '',

      // Business info
      business_name: quoteData.business_name || '',
      business_email: quoteData.business_email || '',
      business_phone: quoteData.business_phone || '',
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
