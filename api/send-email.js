// api/send-email.js - Vercel Serverless Function
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

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
    const { to, quote_number, client_name, total, pdfBase64 } = req.body;

    // Validate inputs
    if (!to || !quote_number || !pdfBase64) {
      return res.status(400).json({ error: 'Missing required fields: to, quote_number, pdfBase64' });
    }

    // Send email via Resend with PDF attachment
    const response = await resend.emails.send({
      from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
      to: to,
      subject: `Quote ${quote_number} from MZS Lead Gen`,
      html: `
        <h2>Your Quote is Ready</h2>
        <p>Hi ${client_name},</p>
        <p>Please find your quote <strong>${quote_number}</strong> attached.</p>
        <p><strong>Total: R${total}</strong></p>
        <p>Please let us know if you have any questions.</p>
        <p>Best regards,<br>MZS Lead Gen</p>
      `,
      attachments: [
        {
          filename: `quote-${quote_number}.pdf`,
          content: pdfBase64,
          contentType: 'application/pdf'
        }
      ]
    });

    console.log('✅ Email sent successfully:', response.id);
    return res.status(200).json({ 
      success: true, 
      message: 'Email sent successfully',
      emailId: response.id 
    });
  } catch (error) {
    console.error('❌ Email error:', error);
    return res.status(500).json({ 
      error: 'Failed to send email',
      details: error.message 
    });
  }
}
