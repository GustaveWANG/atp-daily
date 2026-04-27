// Backfill — génère un headline pour un épisode existant à partir de son script et de ses matchs.
// Utile pour les épisodes créés avant la migration 002 (qui n'avaient pas de headline).
import type { NextApiRequest, NextApiResponse } from "next";
import Anthropic from "@anthropic-ai/sdk";

const HEADLINE_SYSTEM_PROMPT = `You are the front-page headline writer for The Athletic's tennis section. Given a podcast script and the day's match results, return a single punchy headline that hooks readers — the kind that makes someone click on a phone notification.

Rules:
- 50 to 80 characters
- No markdown, no quotation marks, no trailing period
- Sports-journalist tone: name a key player or storyline, suggest stakes or drama
- Output ONLY the headline text, nothing else`;

interface MatchSummary {
  winner_name: string;
  loser_name: string;
  score: string;
  round: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const date =
    typeof req.query.date === "string"
      ? req.query.date
      : new Date().toISOString().slice(0, 10);

  const { supabaseAdmin } = await import("@/lib/supabase-server");

  const { data: episode, error: epError } = await supabaseAdmin
    .from("episodes")
    .select("script, headline")
    .eq("date", date)
    .single();

  if (epError || !episode) {
    return res.status(404).json({ error: "Episode not found for this date" });
  }
  if (!episode.script) {
    return res.status(400).json({ error: "Episode has no script yet" });
  }

  const { data: matchRows } = await supabaseAdmin
    .from("matches")
    .select("winner_name, loser_name, score, round")
    .eq("date", date);

  const matches = (matchRows ?? []) as MatchSummary[];
  const summaries = matches
    .map((m) => `${m.winner_name} def. ${m.loser_name} ${m.score} [${m.round}]`)
    .join("\n");

  const userPrompt = `Date: ${date}
Match results:
${summaries}

Podcast script (excerpt):
${episode.script.slice(0, 1500)}

Write the headline now. Output ONLY the headline text.`;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    system: HEADLINE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const block = response.content.find((b) => b.type === "text");
  const headline = block?.type === "text" ? block.text.trim().replace(/^["']|["']$/g, "") : "";

  if (!headline) {
    return res.status(500).json({ error: "Empty headline from Claude" });
  }

  const { error: updateError } = await supabaseAdmin
    .from("episodes")
    .update({ headline })
    .eq("date", date);

  if (updateError) {
    return res.status(500).json({ error: `Update failed: ${updateError.message}` });
  }

  return res.status(200).json({ ok: true, date, headline });
}
