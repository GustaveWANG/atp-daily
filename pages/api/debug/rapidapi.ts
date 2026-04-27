// Endpoint de diagnostic — teste plusieurs chemins de l'API pour identifier
// la structure correcte. Protégé par CRON_SECRET.
import type { NextApiRequest, NextApiResponse } from "next";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY!;
const RAPIDAPI_HOST = "tennis-api-atp-wta-itf.p.rapidapi.com";

async function tryEndpoint(path: string, params: Record<string, string>) {
  const url = new URL(`https://${RAPIDAPI_HOST}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  try {
    const res = await fetch(url.toString(), {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST,
      },
    });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { path: url.pathname + url.search, http_status: res.status, body };
  } catch (err) {
    return { path, http_status: 0, body: (err as Error).message };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const date =
    typeof req.query.date === "string"
      ? req.query.date
      : new Date().toISOString().slice(0, 10);

  // Inspecte les roundIds des matchs du 26 avril dans le tournoi 21325 (Madrid)
  type MatchEntry = { id: string; date: string; roundId: number; player1: { name: string }; player2: { name: string } };
  type ResultsBody = { data: { singles: MatchEntry[]; qualifying: MatchEntry[] } };

  const r = await tryEndpoint(`/tennis/v2/atp/tournament/results/21325`, {});
  const body = r.body as ResultsBody;
  const singles: MatchEntry[] = body?.data?.singles ?? [];
  const qualifying: MatchEntry[] = body?.data?.qualifying ?? [];

  const april26Singles = singles.filter((m) => m.date?.startsWith("2026-04-26"));
  const april26Qualifying = qualifying.filter((m) => m.date?.startsWith("2026-04-26"));

  return res.status(200).json({
    status: r.http_status,
    total_singles: singles.length,
    total_qualifying: qualifying.length,
    april26_singles_count: april26Singles.length,
    april26_qualifying_count: april26Qualifying.length,
    april26_singles_roundIds: [...new Set(april26Singles.map((m) => m.roundId))],
    april26_qualifying_roundIds: [...new Set(april26Qualifying.map((m) => m.roundId))],
    sample_singles: april26Singles.slice(0, 3).map((m) => ({
      date: m.date?.slice(0, 10),
      roundId: m.roundId,
      p1: m.player1?.name,
      p2: m.player2?.name,
    })),
  });
}
