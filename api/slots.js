// Vercel Serverless Function — GET /api/slots?date=YYYY-MM-DD
// Reads from a single "slots" hash: field "date|time" -> "true"

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
    const result = await redis(["HGETALL", "slots"]);
    const flat = result.result || []; // [field1, value1, field2, value2, ...]

    const booked = [];
    for (let i = 0; i < flat.length; i += 2) {
      const field = flat[i]; // "2026-07-29|7:00 PM"
      const [fieldDate, time] = field.split("|");
      if (fieldDate === date) booked.push(time);
    }

    return res.status(200).json({ booked });
  } catch (err) {
    console.error("Redis error:", err);
    return res.status(500).json({ error: "could not fetch availability" });
  }
}