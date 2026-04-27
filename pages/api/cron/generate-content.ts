import type { NextApiRequest, NextApiResponse } from "next";
import Anthropic from "@anthropic-ai/sdk";
import { fetchAndSeedMatches } from "@/lib/rapidapi-atp";

// ── Types internes ────────────────────────────────────────────────────────────

interface MatchStats {
  aces: number;
  double_faults: number;
  first_serve_pct: number;
  bp_converted: number;
  bp_total: number;
}

interface MatchRow {
  id: string;
  tournament: string;
  round: string;
  surface: string;
  date: string;
  winner_name: string;
  winner_country: string;
  winner_seed: number | null;
  loser_name: string;
  loser_country: string;
  loser_seed: number | null;
  score: string;
  winner_stats: MatchStats;
  loser_stats: MatchStats;
  recap: string | null;
}

interface EpisodeMetadata {
  title: string;
  headline: string;
  chapter_titles: string[];
  player_of_day: {
    name: string;
    country: string;
    stats: { first_serve: number; aces: number; break_pts: number };
    quote: string;
  };
  insights: Array<{ label: string; value: string; player: string }>;
  the_read: string;
  bracket_watch: string;
}

// ── Prompts stables — mis en cache via cache_control: ephemeral ───────────────

// Seuil de cache Sonnet 4.6 : 2048 tokens — ces prompts sont en dessous mais
// la structure est correcte pour évoluer. Le cache se paie à la première req.
const RECAP_SYSTEM_PROMPT = `You are a sports journalist writing for The Athletic, a premium sports publication known for its deep, narrative tennis coverage. Your readers are dedicated fans who follow the ATP Tour closely and appreciate sophisticated analysis.

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

const PODCAST_SYSTEM_PROMPT = `You are the scriptwriter for "ATP Daily", a daily tennis podcast hosted by two contrasting personalities.

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

// Prompt très directif pour garantir un JSON valide sans texte parasite
const METADATA_SYSTEM_PROMPT = `You are a JSON generator for ATP Daily, a tennis podcast. Given match results and the podcast script, return a single valid JSON object — no markdown, no preamble, no trailing text. Output ONLY the JSON object.

Required structure:
{
  "title": "string — e.g. 'Madrid Open · April 25, 2026'",
  "headline": "string — a punchy sports-journalist headline summarizing the day, 50 to 80 characters, no markdown, no quotation marks, no trailing period. Think The Athletic or ESPN front-page style: name a key player or storyline, suggest stakes or drama. Examples of tone: 'Sinner's clinical Madrid statement leaves Moller helpless', 'Lehecka emerges as the bottom half's quietest threat', 'Seven matches, three upsets, one Czech revolution on clay'",
  "chapter_titles": ["4 to 6 chapter names derived from the episode content"],
  "player_of_day": {
    "name": "string",
    "country": "string — 3-letter code e.g. ESP",
    "stats": { "first_serve": number, "aces": number, "break_pts": number },
    "quote": "string — 1–2 sentence fictional quote from the player after their win"
  },
  "insights": [
    { "label": "string — stat name", "value": "string — formatted value e.g. '72%'", "player": "string" },
    { "label": "string", "value": "string", "player": "string" }
  ],
  "the_read": "string — 2–3 sentence editorial analysis of the day's biggest story",
  "bracket_watch": "string — 2–3 sentences about the most compelling match-ups coming in the next round"
}

insights must contain exactly 2 items. All fields are required.`;

// ── Constructeurs de prompts ──────────────────────────────────────────────────

function buildRecapPrompt(match: MatchRow): string {
  const wSeed = match.winner_seed ? `#${match.winner_seed} seed, ` : "";
  const lSeed = match.loser_seed ? `#${match.loser_seed} seed, ` : "";
  const ws = match.winner_stats;
  const hasStats = ws.aces > 0 || ws.first_serve_pct > 0;

  const statsBlock = hasStats
    ? `\n${match.winner_name} stats:\n  Aces: ${ws.aces} | Double faults: ${ws.double_faults}\n  First serve: ${ws.first_serve_pct}% | Break points: ${ws.bp_converted}/${ws.bp_total}\n\n${match.loser_name} stats:\n  Aces: ${match.loser_stats.aces} | Double faults: ${match.loser_stats.double_faults}\n  First serve: ${match.loser_stats.first_serve_pct}% | Break points: ${match.loser_stats.bp_converted}/${match.loser_stats.bp_total}\n`
    : "\nDetailed match statistics are not available for this match.\n";

  return `Match: ${match.winner_name} (${wSeed}${match.winner_country}) def. ${match.loser_name} (${lSeed}${match.loser_country})
Score: ${match.score}
Tournament: ${match.tournament} — ${match.round}, ${match.surface} court
Date: ${match.date}
${statsBlock}
Write the three-paragraph match recap now.`;
}

function buildPodcastPrompt(matches: MatchRow[], date: string): string {
  const formattedDate = new Date(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  const summaries = matches
    .map((m) => {
      const wSeed = m.winner_seed ? `#${m.winner_seed} ` : "";
      const lSeed = m.loser_seed ? `#${m.loser_seed} ` : "";
      const ws = m.winner_stats;
      const hasStats = ws.aces > 0 || ws.first_serve_pct > 0;
      const statsLine = hasStats
        ? `\n  ${m.winner_name}: ${ws.aces} aces, ${ws.first_serve_pct}% first serve, ${ws.bp_converted}/${ws.bp_total} BP\n  ${m.loser_name}: ${m.loser_stats.aces} aces, ${m.loser_stats.first_serve_pct}% first serve, ${m.loser_stats.bp_converted}/${m.loser_stats.bp_total} BP`
        : "";
      return `${wSeed}${m.winner_name} (${m.winner_country}) def. ${lSeed}${m.loser_name} (${m.loser_country}) ${m.score} [${m.round}]${statsLine}`;
    })
    .join("\n\n");

  return `Today is ${formattedDate}. Here are all the ${matches[0].tournament} results:

${summaries}

Write the ATP Daily podcast episode script. Structure it as:
1. Opening — welcome listeners and tease the day's biggest stories (2–3 exchanges)
2. Match coverage — discuss the 2–3 most compelling matches, mixing tactics and storylines (3–5 exchanges per match)
3. Top performer — name and celebrate the day's standout player with specific reasons (2–3 exchanges)
4. Closing — tease what's coming in the next round and sign off warmly (2 exchanges)

Start with ALEX speaking.`;
}

function buildMetadataPrompt(matches: MatchRow[], script: string, date: string): string {
  const formattedDate = new Date(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  const summaries = matches
    .map((m) => {
      const ws = m.winner_stats;
      return `${m.winner_name} def. ${m.loser_name} ${m.score} — ${ws.aces} aces, ${ws.first_serve_pct}% 1st serve, ${ws.bp_converted}/${ws.bp_total} BP`;
    })
    .join("\n");

  // Extrait les 800 premiers caractères du script pour le contexte
  const scriptExcerpt = script.slice(0, 800);

  return `Date: ${formattedDate}
Tournament: ${matches[0]?.tournament ?? "ATP"}
Matches:
${summaries}

Podcast script (excerpt):
${scriptExcerpt}

Generate the JSON metadata object for this episode.`;
}

// ── Handler principal ─────────────────────────────────────────────────────────

type CronResponse =
  | { ok: true; date: string; matches: number; recap_count: number }
  | { error: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CronResponse>
) {
  // Vercel cron envoie Authorization: Bearer <CRON_SECRET> automatiquement
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Date : ?date=YYYY-MM-DD pour les tests manuels, sinon aujourd'hui (UTC)
  const date =
    typeof req.query.date === "string"
      ? req.query.date
      : new Date().toISOString().slice(0, 10);

  const { supabaseAdmin } = await import("@/lib/supabase-server");
  const client = new Anthropic();

  // ── 1. Fetch + seed depuis RapidAPI ──────────────────────────────────────────
  // Best-effort : si l'API est vide (début de journée), on continue avec la DB
  try {
    await fetchAndSeedMatches(date);
  } catch (err) {
    console.error("RapidAPI fetch error:", (err as Error).message);
  }

  // ── 2. Charger les matchs depuis Supabase ─────────────────────────────────
  const { data: matchRows, error: fetchError } = await supabaseAdmin
    .from("matches")
    .select("*")
    .eq("date", date)
    .order("created_at");

  if (fetchError) {
    return res.status(500).json({ error: fetchError.message });
  }

  if (!matchRows?.length) {
    return res.status(200).json({ ok: true, date, matches: 0, recap_count: 0 });
  }

  const matches = matchRows as MatchRow[];

  // ── 3. Générer les recaps manquants (séquentiel — un appel par match) ─────
  let recapCount = 0;

  for (const match of matches) {
    if (match.recap) continue; // déjà généré lors d'un run précédent

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: RECAP_SYSTEM_PROMPT,
            // Le cache se réutilise pour tous les matchs du même run
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: buildRecapPrompt(match) }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      const recap = textBlock?.type === "text" ? textBlock.text : "";

      if (recap) {
        await supabaseAdmin.from("matches").update({ recap }).eq("id", match.id);
        match.recap = recap;
        recapCount++;
      }
    } catch (err) {
      console.error(`Recap error for match ${match.id}:`, (err as Error).message);
    }
  }

  // ── 4. Générer le script podcast ─────────────────────────────────────────
  let script = "";

  try {
    const podcastResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: PODCAST_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildPodcastPrompt(matches, date) }],
    });

    const scriptBlock = podcastResponse.content.find((b) => b.type === "text");
    script = scriptBlock?.type === "text" ? scriptBlock.text : "";
  } catch (err) {
    console.error("Podcast script error:", (err as Error).message);
  }

  // ── 5. Générer les métadonnées structurées de l'épisode ───────────────────
  let meta: Partial<EpisodeMetadata> = {};

  try {
    const metaResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: METADATA_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: buildMetadataPrompt(matches, script, date),
        },
      ],
    });

    const metaBlock = metaResponse.content.find((b) => b.type === "text");
    const metaRaw = metaBlock?.type === "text" ? metaBlock.text : "{}";
    meta = JSON.parse(metaRaw) as EpisodeMetadata;
  } catch (err) {
    console.error("Metadata generation error:", (err as Error).message);
  }

  // ── 6. Upsert de l'épisode dans Supabase ─────────────────────────────────
  const { error: episodeError } = await supabaseAdmin
    .from("episodes")
    .upsert(
      {
        date,
        script: script || null,
        title: meta.title ?? null,
        headline: meta.headline ?? null,
        chapter_titles: meta.chapter_titles ?? null,
        player_of_day: meta.player_of_day ?? null,
        insights: meta.insights ?? null,
        the_read: meta.the_read ?? null,
        bracket_watch: meta.bracket_watch ?? null,
      },
      { onConflict: "date" }
    );

  if (episodeError) {
    console.error("Episode upsert error:", episodeError.message);
  }

  return res.status(200).json({
    ok: true,
    date,
    matches: matches.length,
    recap_count: recapCount,
  });
}
