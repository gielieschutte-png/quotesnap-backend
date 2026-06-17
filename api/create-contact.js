// /api/create-contact.js
// Azanco — Create GHL Contact on New Signup
// Called by Base44 when a new user registers.
// Creates GHL contact and sets trial fields automatically.
 
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
 
// Trial length in days
const TRIAL_DAYS = 14;
 
function getTrialEndDate() {
  const d = new Date();
  d.setDate(d.getDate() + TRIAL_DAYS);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
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
    // First check if contact already exists
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
      console.log(`Contact already exists for: ${email}`);
      return res.status(200).json({ success: true, contactId: existing[0].id, existing: true });
    }
 
    // Create new contact
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
          firstName: firstName || "",
          lastName: lastName || "",
          phone: phone || "",
          source: "Azanco App",
          customFields: [
            {
              key: "subscription_status",
              field_value: "trial",
            },
            {
              key: "trial_ends_at",
              field_value: trialEndDate,
            },
          ],
        }),
      }
    );
 
    const createData = await createRes.json();
    console.log(`GHL create response: ${JSON.stringify(createData)}`);
 
    if (!createRes.ok) {
      console.error(`Failed to create contact: ${JSON.stringify(createData)}`);
      return res.status(200).json({ success: false, error: createData });
    }
 
    const contactId = createData?.contact?.id;
    console.log(`Created GHL contact: ${contactId} for ${email}`);
 
    // Add contact to Azanco Signup pipeline at Trial stage
    if (contactId) {
      await fetch(`https://services.leadconnectorhq.com/opportunities/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          locationId: GHL_LOCATION_ID,
          contactId,
          name: `${firstName || ""} ${lastName || ""}`.trim() || email,
          pipelineId: "azanco-signup",
          pipelineStageId: "trial",
          status: "open",
        }),
      });
    }
 
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
