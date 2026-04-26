import type { NextApiRequest, NextApiResponse } from "next";
import Anthropic from "@anthropic-ai/sdk";
import type { Match } from "@/lib/mockData";
import { supabaseAdmin } from "@/lib/supabase-server";

// Prompt système stable — le cache_control active le prompt caching côté API.
// Le cache se déclenche à partir de 2048 tokens sur Sonnet 4.6 ; ce prompt
// est en dessous du seuil mais la structure est correcte pour évoluer.
const SYSTEM_PROMPT = `You are a sports journalist writing for The Athletic, a premium sports publication known for its deep, narrative tennis coverage. Your readers are dedicated fans who follow the ATP Tour closely and appreciate sophisticated analysis.

Your match recaps blend sharp tactical insight with compelling storytelling. You do not merely report what happened — you explain why it happened and what it means. You identify the decisive moments, the tactical adjustments, the mental shifts that turned a match.

Style guidelines:
- Open with the result, but frame it with narrative context — the stakes, the tension, what was at play
- Use statistics as evidence for narrative claims, not as a list of facts
- Identify the specific game or set where momentum shifted decisively
- Analyze serving patterns, return depth, and court positioning when relevant
- Reference a player's playing style or history with the surface when it adds insight
- Close by placing the result in the tournament's broader context
- Write in active voice, past tense
- Vary sentence length — short sentences for emphasis, longer ones for analysis
- Avoid clichés: never write "didn't hold back", "gave it their all", or "dug deep"
- Three paragraphs. No headers. No bullet points. No markdown.`;

function buildMatchPrompt(match: Match): string {
  const winnerSeed = match.winner.seed ? `#${match.winner.seed} seed, ` : "";
  const loserSeed = match.loser.seed ? `#${match.loser.seed} seed, ` : "";

  return `Match: ${match.winner.name} (${winnerSeed}${match.winner.country}) def. ${match.loser.name} (${loserSeed}${match.loser.country})
Score: ${match.score}
Tournament: ${match.tournament} — ${match.round}, ${match.surface} court
Date: ${match.date}

${match.winner.name} stats:
  Aces: ${match.winnerStats.aces} | Double faults: ${match.winnerStats.doubleFaults}
  First serve: ${match.winnerStats.firstServePercentage}% | Break points: ${match.winnerStats.breakPointsConverted}/${match.winnerStats.breakPointsTotal}

${match.loser.name} stats:
  Aces: ${match.loserStats.aces} | Double faults: ${match.loserStats.doubleFaults}
  First serve: ${match.loserStats.firstServePercentage}% | Break points: ${match.loserStats.breakPointsConverted}/${match.loserStats.breakPointsTotal}

Write the three-paragraph match recap now.`;
}

type RecapResponse = { recap: string } | { error: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<RecapResponse>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const match = req.body as Match;

  if (!match?.id || !match?.winner || !match?.loser) {
    return res.status(400).json({ error: "Invalid match data" });
  }

  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: buildMatchPrompt(match),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const recap = textBlock && textBlock.type === "text" ? textBlock.text : "";

  // Persistance dans Supabase — best-effort (n'échoue pas la requête si le DB plante)
  const { error: dbError } = await supabaseAdmin.from("matches").upsert({
    id: match.id,
    tournament: match.tournament,
    round: match.round,
    surface: match.surface,
    date: match.date,
    winner_name: match.winner.name,
    winner_country: match.winner.country,
    winner_seed: match.winner.seed ?? null,
    loser_name: match.loser.name,
    loser_country: match.loser.country,
    loser_seed: match.loser.seed ?? null,
    score: match.score,
    winner_stats: {
      aces: match.winnerStats.aces,
      double_faults: match.winnerStats.doubleFaults,
      first_serve_pct: match.winnerStats.firstServePercentage,
      bp_converted: match.winnerStats.breakPointsConverted,
      bp_total: match.winnerStats.breakPointsTotal,
    },
    loser_stats: {
      aces: match.loserStats.aces,
      double_faults: match.loserStats.doubleFaults,
      first_serve_pct: match.loserStats.firstServePercentage,
      bp_converted: match.loserStats.breakPointsConverted,
      bp_total: match.loserStats.breakPointsTotal,
    },
    recap,
  });
  if (dbError) console.error("Supabase upsert error:", dbError.message);

  return res.status(200).json({ recap });
}
