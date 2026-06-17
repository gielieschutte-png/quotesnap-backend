// /api/check-subscription.js
// DIAGNOSTIC VERSION — returns raw GHL response for debugging
 
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
 
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
 
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email is required" });
 
  try {
    // Try email filter
    const url1 = `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`;
    const res1 = await fetch(url1, {
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2021-07-28",
      },
    });
    const data1 = await res1.json();
 
    // Try query search
    const url2 = `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`;
    const res2 = await fetch(url2, {
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2021-07-28",
      },
    });
    const data2 = await res2.json();
 
    // Return everything raw so we can see what GHL sends back
    return res.status(200).json({
      email_used: email,
      location_id: GHL_LOCATION_ID,
      api_key_first10: GHL_API_KEY ? GHL_API_KEY.substring(0, 10) : "NOT SET",
      email_filter_result: data1,
      query_search_result: data2,
    });
 
  } catch (err) {
    return res.status(200).json({ error: err.message });
  }
}
