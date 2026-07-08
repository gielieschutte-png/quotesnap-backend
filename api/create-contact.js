// /api/create-contact.js
// Azanco — Create or Update GHL Contact
//
// UPDATED 8 July 2026: now accepts an `isNewCompany` flag in the request
// body. Every signup still creates/updates a GHL Contact (so support can
// always look up any user), but an Opportunity is now ONLY created when
// isNewCompany is true — i.e. only the person actually creating a brand
// new company gets a pipeline card. Team members joining an EXISTING
// company via Company Code no longer spawn their own duplicate Trial
// Opportunity.
//
// IMPORTANT: this only works once the Base44 frontend is updated to pass
// isNewCompany: true/false in the request body, based on whether the user
// went through "Create a company" vs "Join via Company Code" during
// onboarding. Until that frontend change ships, this flag will be
// undefined on every request — see the fallback behaviour noted below.

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const TRIAL_DAYS = 14;

// GHL Pipeline IDs
// NOTE: these stage IDs were re-verified directly against GHL's live pipeline
// data on 7 July 2026 (via the opportunities/pipelines API response) after
// discovering Active and Grace period had drifted from their original June
// 2026 mapping — likely when the Cancelled stage was added. This mapping is
// confirmed correct as of 7 July 2026.
const PIPELINE_ID = "OockSDqNecRfQul2RhxH";
const STAGE_IDS = {
  trial: "0d264ba6-875e-46bc-8da8-97616337c5cf",
  active: "edae721c-b7e5-4a1a-8c12-445fd2b3fce5",
  grace: "42e4407b-9bc9-48c3-b7be-bbbbe4ad3bfe",
  locked: "60fc6bfe-41f2-4382-aa4c-a80f58e28767",
  cancelled: "9c788839-7a33-4d45-ba7c-0868fd7636e7",
};

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
  console.log(`PUT contact ${contactId} status=${res.status}`);
  return { status: res.status, data };
}

async function findExistingOpportunity(contactId) {
  const res = await fetch(
    `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${PIPELINE_ID}&contact_id=${contactId}`,
    {
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2021-07-28",
      },
    }
  );
  if (!res.ok) {
    console.error("Opportunity search failed:", await res.text());
    return null;
  }
  const data = await res.json();
  const opportunities = data.opportunities || [];
  return opportunities[0] || null;
}

async function createOpportunity(contactId, contactName) {
  const res = await fetch(
    `https://services.leadconnectorhq.com/opportunities/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        contactId,
        name: contactName,
        pipelineId: PIPELINE_ID,
        pipelineStageId: STAGE_IDS.trial,
        status: "open",
      }),
    }
  );
  const data = await res.json();
  console.log(`Create opportunity status=${res.status}`);
  return { status: res.status, data };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, firstName, lastName, phone, businessName, isNewCompany } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  // FALLBACK BEHAVIOUR while Base44 hasn't been updated yet to send this
  // flag: isNewCompany will be `undefined`. We treat that the SAME as the
  // old behaviour (create an Opportunity) so nothing breaks or silently
  // stops working before the frontend change ships tonight. Once Base44
  // is sending real true/false values, this fallback stops mattering.
  const shouldCreateOpportunity = isNewCompany !== false;

  console.log(
    `Received: email=${email}, firstName=${firstName}, lastName=${lastName}, phone=${phone}, businessName=${businessName}, isNewCompany=${isNewCompany} (shouldCreateOpportunity=${shouldCreateOpportunity})`
  );

  try {
    // Search for existing contact
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

      // Update standard fields
      const updatePayload = {};
      if (firstName) updatePayload.firstName = firstName;
      if (lastName) updatePayload.lastName = lastName;
      if (phone) updatePayload.phone = phone;
      if (businessName) updatePayload.companyName = businessName;

      if (Object.keys(updatePayload).length > 0) {
        await ghlPut(contactId, updatePayload);
      }

      // NEW (8 July 2026): handles the real signup sequence — Register.jsx
      // creates this contact FIRST (before the user has chosen Create vs
      // Join), with isNewCompany:false, so no Opportunity yet. If the user
      // then goes through "Create a Company", Onboarding.jsx calls this
      // endpoint AGAIN on the same (now-existing) contact with
      // isNewCompany:true — this is where we retroactively create the
      // Opportunity, but only if one doesn't already exist for them.
      if (shouldCreateOpportunity) {
        const existingOpp = await findExistingOpportunity(contactId);
        if (!existingOpp) {
          const fullNameForOpp = `${firstName || email.split("@")[0]} ${lastName || ""}`.trim();
          await createOpportunity(contactId, fullNameForOpp);
          console.log(`Retroactively created Opportunity for existing contact: ${contactId}`);
        } else {
          console.log(`Opportunity already exists for contact ${contactId} — not creating another.`);
        }
      }

      return res.status(200).json({ success: true, contactId, existing: true });
    }

    // Create new contact — this ALWAYS happens, regardless of isNewCompany,
    // so every person (owner or team member) is findable in GHL for support.
    console.log(`Creating new contact for: ${email}`);
    const trialEndDate = getTrialEndDate();
    const fullName = `${firstName || email.split("@")[0]} ${lastName || ""}`.trim();

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
      return res.status(200).json({ success: false, error: "No contact ID returned" });
    }

    // Set trial custom fields — every contact gets these, owner or member,
    // so support can see trial/subscription context for anyone.
    await ghlPut(contactId, {
      customFields: [
        { key: "subscription_status", field_value: "trial" },
        { key: "trial_ends_at", field_value: trialEndDate },
      ],
    });

    // Only create a pipeline Opportunity for genuinely NEW companies.
    // Team members joining an existing company via Company Code get a
    // Contact (for support visibility) but no separate Opportunity card —
    // the company already has one, created when its owner signed up.
    if (shouldCreateOpportunity) {
      await createOpportunity(contactId, fullName);
      console.log(`Contact created and added to Trial pipeline: ${contactId}`);
    } else {
      console.log(`Contact created WITHOUT a new Opportunity (joined existing company): ${contactId}`);
    }

    return res.status(200).json({ success: true, contactId, trialEndDate, existing: false });

  } catch (err) {
    console.error("Error:", err);
    return res.status(200).json({ success: false, error: err.message });
  }
}
