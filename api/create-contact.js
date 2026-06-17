// /api/create-contact.js
// Azanco — Create GHL Contact on New Signup

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

const TRIAL_DAYS = 14;

function getTrialEndDate() {
  const d = new Date();
  d.setDate(d.getDate() + TRIAL_DAYS);
  return d.toISOString().split("T")[0];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, firstName, lastName, phone } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    // Check if contact already exists
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-07-28",
        },
      }
    );
    const searchData = await searchRes.json();
    const existing = searchData?.contacts || [];

    if (existing.length > 0) {
      console.log(`Contact already exists: ${email}`);
      return res.status(200).json({ success: true, contactId: existing[0].id, existing: true });
    }

    const trialEndDate = getTrialEndDate();

    // Create contact — no customFields on creation, GHL is unreliable with them
    const createRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          locationId: GHL_LOCATION_ID,
          email,
          firstName: firstName || email.split("@")[0],
          lastName: lastName || "",
          phone: phone || "",
          source: "Azanco App",
        }),
      }
    );

    const createData = await createRes.json();
    console.log(`Create response: ${JSON.stringify(createData)}`);

    const contactId = createData?.contact?.id;
    if (!contactId) {
      console.error(`No contact ID returned: ${JSON.stringify(createData)}`);
      return res.status(200).json({ success: false, error: "No contact ID returned" });
    }

    console.log(`Created contact: ${contactId}`);

    // Now update the contact with custom fields separately
    const updateRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customFields: [
            { key: "subscription_status", field_value: "trial" },
            { key: "trial_ends_at", field_value: trialEndDate },
          ],
        }),
      }
    );

    const updateData = await updateRes.json();
    console.log(`Update response: ${JSON.stringify(updateData)}`);

    return res.status(200).json({
      success: true,
      contactId,
      trialEndDate,
      existing: false,
    });

  } catch (err) {
    console.error("create-contact error:", err);
    return res.status(200).json({ success: false, error: err.message });
  }
}
