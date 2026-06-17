// /api/create-contact.js
// Azanco — Create or Update GHL Contact

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const TRIAL_DAYS = 14;

function getTrialEndDate() {
  const d = new Date();
  d.setDate(d.getDate() + TRIAL_DAYS);
  return d.toISOString().split("T")[0];
}

async function ghlPut(contactId, payload) {
  const res = await fetch(
    `https://services.leadconnectorhq.com/contacts/${contactId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );
  const data = await res.json();
  console.log(`PUT ${contactId} status=${res.status} result=${JSON.stringify(data).substring(0, 150)}`);
  return { status: res.status, data };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, firstName, lastName, phone, businessName } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  console.log(`Received: email=${email}, firstName=${firstName}, lastName=${lastName}, phone=${phone}, businessName=${businessName}`);

  try {
    // Search for contact
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
    const contacts = searchData?.contacts || [];

    // Exact email match only
    const exactMatch = contacts.find(
      (c) => (c.email || "").toLowerCase() === email.toLowerCase()
    );

    if (exactMatch) {
      const contactId = exactMatch.id;
      console.log(`Exact match: ${contactId}`);

      // Standard fields — phone and companyName are top-level standard fields
      const standardPayload = {};
      if (firstName) standardPayload.firstName = firstName;
      if (lastName) standardPayload.lastName = lastName;
      if (phone) standardPayload.phone = phone;
      if (businessName) standardPayload.companyName = businessName;

      if (Object.keys(standardPayload).length > 0) {
        await ghlPut(contactId, standardPayload);
      }

      return res.status(200).json({ success: true, contactId, existing: true });
    }

    // Create new contact
    console.log(`Creating new contact for: ${email}`);
    const trialEndDate = getTrialEndDate();

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
          companyName: businessName || "",
          source: "Azanco App",
        }),
      }
    );

    const createData = await createRes.json();
    console.log(`Create status=${createRes.status}`);
    const contactId = createData?.contact?.id;

    if (!contactId) {
      console.error(`No contact ID: ${JSON.stringify(createData).substring(0, 300)}`);
      return res.status(200).json({ success: false, error: "No contact ID" });
    }

    // Set trial custom fields
    await ghlPut(contactId, {
      customFields: [
        { key: "subscription_status", field_value: "trial" },
        { key: "trial_ends_at", field_value: trialEndDate },
      ],
    });

    return res.status(200).json({ success: true, contactId, trialEndDate, existing: false });

  } catch (err) {
    console.error("Error:", err);
    return res.status(200).json({ success: false, error: err.message });
  }
}
