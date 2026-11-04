// GET /api/config — public schedule + payment settings for the booking page.
import { publicConfig } from "./_config.js";
import { requireMethod } from "./_lib.js";

export default function handler(req, res) {
  if (!requireMethod(req, res, "GET")) return;
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return res.status(200).json(publicConfig());
}
