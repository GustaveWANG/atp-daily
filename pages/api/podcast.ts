import type { NextApiRequest, NextApiResponse } from "next";
import Anthropic from "@anthropic-ai/sdk";
import { matches } from "@/lib/mockData";

// Prompt système stable — mis en cache côté API Anthropic
const SYSTEM_PROMPT = `You are the scriptwriter for "ATP Daily", a daily tennis podcast hosted by two contrasting personalities.

Hosts:
- ALEX: Curious and enthusiastic. Draws listeners in with questions and emotional reactions. Gets genuinely excited about big moments and human storylines. Always speaks first.
- SAM: Analytical and witty. Grounds Alex with data, tactics, and dry humor. Has a sharp eye for what actually decided a match. Never misses a well-timed quip.

Writing rules:
- Format every line as "ALEX: [dialogue]" or "SAM: [dialogue]", each on its own line
- Each speaking turn is 2–4 sentences
- Write as spoken audio — natural speech patterns, contractions, rhetorical questions are fine
- No stage directions, no parentheses, no markdown, no bullet points
- Banter should feel spontaneous, not recited
- Total script: 450–550 words of dialogue`;

function buildPodcastPrompt(): string {
  const matchSummaries = matches
    .map((m) => {
      const ws = m.winnerStats;
      const ls = m.loserStats;
      const wSeed = m.winner.seed ? `#${m.winner.seed} ` : "";
      const lSeed = m.loser.seed ? `#${m.loser.seed} ` : "";
      return `${wSeed}${m.winner.name} (${m.winner.country}) def. ${lSeed}${m.loser.name} (${m.loser.country}) ${m.score}
  ${m.winner.name}: ${ws.aces} aces, ${ws.firstServePercentage}% first serve, ${ws.breakPointsConverted}/${ws.breakPointsTotal} break pts converted
  ${m.loser.name}: ${ls.aces} aces, ${ls.firstServePercentage}% first serve, ${ls.breakPointsConverted}/${ls.breakPointsTotal} break pts converted`;
    })
    .join("\n\n");

  return `Today is April 25, 2026. Here are all the Madrid Open results:

${matchSummaries}

Write the ATP Daily podcast episode script. Structure it as:
1. Opening — welcome listeners and tease the day's biggest stories (2–3 exchanges)
2. Match coverage — discuss the 2–3 most compelling matches, mixing tactics and storylines (3–5 exchanges per match)
3. Top performer — name and celebrate the day's standout player with specific reasons (2–3 exchanges)
4. Closing — tease what's coming in the next round and sign off warmly (2 exchanges)

Start with ALEX speaking.`;
}

type PodcastResponse = { script: string } | { error: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PodcastResponse>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
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
        content: buildPodcastPrompt(),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const script = textBlock && textBlock.type === "text" ? textBlock.text : "";

  return res.status(200).json({ script });
}
