// Vercel Serverless Function — POST /api/book
// Body: { date, time, name, email, whatsapp, focus, context }
//
// Schema:
//   slots    (hash) -> field "date|time" = "true"        (availability)
//   bookings (hash) -> field <booking-id> = JSON string   (booking data)

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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const { date, time, name, email, whatsapp, focus, context } = req.body || {};
  if (!date || !time || !name || !email || !whatsapp) {
    return res.status(400).json({ error: "missing required fields" });
  }

  try {
    // HSETNX returns 1 if the field was newly set, 0 if it already existed —
    // atomic, so two simultaneous bookings for the same slot can't both win.
    const field = `${date}|${time}`;
    const claim = await redis(["HSETNX", "slots", field, "true"]);
    if (claim.result === 0) {
      return res.status(409).json({ error: "slot_taken" });
    }

    const id = crypto.randomUUID();
    const record = JSON.stringify({
      id, date, time, name, email, whatsapp,
      focus: focus || "",
      context: context || "",
      createdAt: new Date().toISOString(),
    });

    await redis(["HSET", "bookings", id, record]);

    return res.status(200).json({ success: true, id });
  } catch (err) {
    console.error("Redis error:", err);
    return res.status(500).json({ error: "could not save booking" });
  }
}