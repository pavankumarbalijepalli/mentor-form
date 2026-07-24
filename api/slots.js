// Vercel Serverless Function — GET /api/slots?date=YYYY-MM-DD
// Returns which times are already booked for that date.

async function redis(command) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "date is required" });
  }

  try {
    const result = await redis(["SMEMBERS", `booked:${date}`]);
    return res.status(200).json({ booked: result.result || [] });
  } catch (err) {
    console.error("Redis error:", err);
    return res.status(500).json({ error: "could not fetch availability" });
  }
}
