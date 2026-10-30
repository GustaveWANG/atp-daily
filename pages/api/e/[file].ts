import { createHash } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { isEpisodeDate, logListenEvent } from "@/lib/listen-log";

// /api/e/2026-10-29.mp3 — URL d'audio du flux RSS.
// Compte le téléchargement puis redirige vers le MP3 dans Supabase Storage.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const file = String(req.query.file ?? "");
  const date = file.replace(/\.mp3$/, "");
  if (!isEpisodeDate(date)) {
    res.status(404).end();
    return;
  }

  const { supabaseAdmin } = await import("@/lib/supabase-server");
  const { data } = await supabaseAdmin
    .from("episodes")
    .select("audio_url")
    .eq("date", date)
    .maybeSingle();
  const audioUrl = (data as { audio_url: string | null } | null)?.audio_url;
  if (!audioUrl) {
    res.status(404).end();
    return;
  }

  // Les applis sondent d'abord avec HEAD ou une petite Range ; on ne compte
  // que les GET, le dédoublonnage se fait ensuite par client_hash.
  if (req.method === "GET") {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress ?? "";
    const ua = req.headers["user-agent"] ?? "";
    const day = new Date().toISOString().slice(0, 10);
    await logListenEvent({
      episode_date: date,
      event: "download",
      client_hash: createHash("sha256").update(`${ip}|${ua}|${day}`).digest("hex").slice(0, 32),
      user_agent: ua.slice(0, 300),
    });
  }

  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, audioUrl);
}
