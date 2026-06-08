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
    const { to, quote_number, client_name, total, pdfBase64, doc_label, subject, body_intro, site_photos } = req.body;

    // Validate inputs
    if (!to || !quote_number || !pdfBase64) {
      return res.status(400).json({ error: 'Missing required fields: to, quote_number, pdfBase64' });
    }

    // Use doc_label to determine if this is a Quote or Invoice
    const label = doc_label === 'Invoice' ? 'Invoice' : 'Quote';
    const emailSubject = subject || `${label} ${quote_number} from MZS Lead Gen`;
    const emailHeading = label === 'Invoice' ? 'Your Invoice is Ready' : 'Your Quote is Ready';
    const filename = label === 'Invoice' ? `invoice-${quote_number}.pdf` : `quote-${quote_number}.pdf`;

    // Start with the PDF attachment
    const attachments = [
      {
        filename: filename,
        content: pdfBase64,
        contentType: 'application/pdf'
      }
    ];

    // Fetch and attach site photos if provided
    if (site_photos && Array.isArray(site_photos) && site_photos.length > 0) {
      console.log(`📸 Attaching ${site_photos.length} site photo(s)...`);
      
      for (let i = 0; i < site_photos.length; i++) {
        const photoUrl = site_photos[i];
        if (!photoUrl) continue;

        try {
          const photoResponse = await fetch(photoUrl);
          if (!photoResponse.ok) {
            console.warn(`⚠️ Could not fetch photo ${i + 1}: ${photoUrl}`);
            continue;
          }

          const photoBuffer = await photoResponse.arrayBuffer();
          const photoBase64 = Buffer.from(photoBuffer).toString('base64');

          // Detect file extension from URL
          const urlParts = photoUrl.split('?')[0]; // remove query params
          const ext = urlParts.split('.').pop()?.toLowerCase() || 'jpg';
          const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';

          attachments.push({
            filename: `site-photo-${i + 1}.${ext}`,
            content: photoBase64,
            contentType: mimeType
          });

          console.log(`✅ Photo ${i + 1} attached: site-photo-${i + 1}.${ext}`);
        } catch (photoError) {
          console.warn(`⚠️ Failed to attach photo ${i + 1}:`, photoError.message);
          // Continue — don't fail the whole email if one photo fails
        }
      }
    }

    // Send email via Resend
    const response = await resend.emails.send({
      from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
      to: to,
      subject: emailSubject,
      html: `
        <h2>${emailHeading}</h2>
        <p>Hi ${client_name},</p>
        <p>Please find your ${label.toLowerCase()} <strong>${quote_number}</strong> attached.</p>
        <p><strong>Total: R${total}</strong></p>
        ${site_photos && site_photos.length > 0 ? `<p>Site photos (${site_photos.length}) are also attached for your reference.</p>` : ''}
        <p>Please let us know if you have any questions.</p>
        <p>Best regards,<br>MZS Lead Gen</p>
      `,
      attachments: attachments
    });

    console.log(`✅ ${label} email sent successfully:`, response.id);
    return res.status(200).json({
      success: true,
      message: `${label} email sent successfully`,
      emailId: response.id,
      photosAttached: attachments.length - 1
    });

  } catch (error) {
    console.error('❌ Email error:', error);
    return res.status(500).json({
      error: 'Failed to send email',
      details: error.message
    });
  }
}
