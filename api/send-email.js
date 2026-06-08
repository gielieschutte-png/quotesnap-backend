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
    const { to, quote_number, client_name, total, pdfBase64, doc_label, subject, site_photos } = req.body;

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

    // Attach site photos — supports both base64 objects AND plain URLs
    if (site_photos && Array.isArray(site_photos) && site_photos.length > 0) {
      console.log(`📸 Attaching ${site_photos.length} site photo(s)...`);

      for (let i = 0; i < site_photos.length; i++) {
        const photo = site_photos[i];
        if (!photo) continue;

        try {
          // If Base44 sent base64 objects: { base64, mimeType, filename }
          if (typeof photo === 'object' && photo.base64) {
            attachments.push({
              filename: photo.filename || `site-photo-${i + 1}.jpg`,
              content: photo.base64,
              contentType: photo.mimeType || 'image/jpeg'
            });
            console.log(`✅ Photo ${i + 1} attached from base64 object`);

          // If Base44 sent plain URL strings — try to fetch them
          } else if (typeof photo === 'string' && photo.startsWith('http')) {
            const photoResponse = await fetch(photo);
            if (!photoResponse.ok) {
              console.warn(`⚠️ Could not fetch photo ${i + 1}: ${photo} — Status: ${photoResponse.status}`);
              continue;
            }

            const photoBuffer = await photoResponse.arrayBuffer();
            const photoBase64 = Buffer.from(photoBuffer).toString('base64');

            const urlParts = photo.split('?')[0];
            const ext = urlParts.split('.').pop()?.toLowerCase() || 'jpg';
            const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';

            attachments.push({
              filename: `site-photo-${i + 1}.${ext}`,
              content: photoBase64,
              contentType: mimeType
            });
            console.log(`✅ Photo ${i + 1} attached from URL`);

          } else {
            console.warn(`⚠️ Photo ${i + 1} has unrecognised format:`, typeof photo, photo);
          }

        } catch (photoError) {
          console.warn(`⚠️ Failed to attach photo ${i + 1}:`, photoError.message);
          // Continue — don't fail the whole email if one photo fails
        }
      }
    }

    const photosAttached = attachments.length - 1;

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
        ${photosAttached > 0 ? `<p>Site photos (${photosAttached}) are also attached for your reference.</p>` : ''}
        <p>Please let us know if you have any questions.</p>
        <p>Best regards,<br>MZS Lead Gen</p>
      `,
      attachments: attachments
    });

    console.log(`✅ ${label} email sent — emailId: ${response.id} — photos attached: ${photosAttached}`);
    return res.status(200).json({
      success: true,
      message: `${label} email sent successfully`,
      emailId: response.id,
      photosAttached: photosAttached
    });

  } catch (error) {
    console.error('❌ Email error:', error);
    return res.status(500).json({
      error: 'Failed to send email',
      details: error.message
    });
  }
}
