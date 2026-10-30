import type { NextApiRequest, NextApiResponse } from "next";
import { isEpisodeDate, cleanListenerId } from "@/lib/listen-log";

// POST { episode_date, rating?: 1 | -1, comment?: string, listener_id? }
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).end();
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const rating = body.rating === 1 || body.rating === -1 ? body.rating : null;
  const comment =
    typeof body.comment === "string" && body.comment.trim()
      ? body.comment.trim().slice(0, 2000)
      : null;

  if (!isEpisodeDate(body.episode_date) || (rating === null && comment === null)) {
    res.status(400).json({ error: "episode_date and a rating or comment are required" });
    return;
  }

  const { supabaseAdmin } = await import("@/lib/supabase-server");
  const { error } = await supabaseAdmin.from("feedback").insert({
    episode_date: body.episode_date,
    rating,
    comment,
    listener_id: cleanListenerId(body.listener_id),
  });
  if (error) {
    console.error("feedback insert failed:", error.message);
    res.status(500).json({ error: "could not save feedback" });
    return;
  }
  res.status(204).end();
}
