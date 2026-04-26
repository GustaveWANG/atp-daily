import type { NextApiRequest, NextApiResponse } from "next";
import { matches } from "@/lib/mockData";
import { supabaseAdmin } from "@/lib/supabase-server";

// Endpoint de seeding — insère les matchs mock dans Supabase (idempotent via upsert)
// À appeler une seule fois après avoir créé les tables : GET /api/seed
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rows = matches.map((m) => ({
    id: m.id,
    tournament: m.tournament,
    round: m.round,
    surface: m.surface,
    date: m.date,
    winner_name: m.winner.name,
    winner_country: m.winner.country,
    winner_seed: m.winner.seed ?? null,
    loser_name: m.loser.name,
    loser_country: m.loser.country,
    loser_seed: m.loser.seed ?? null,
    score: m.score,
    winner_stats: {
      aces: m.winnerStats.aces,
      double_faults: m.winnerStats.doubleFaults,
      first_serve_pct: m.winnerStats.firstServePercentage,
      bp_converted: m.winnerStats.breakPointsConverted,
      bp_total: m.winnerStats.breakPointsTotal,
    },
    loser_stats: {
      aces: m.loserStats.aces,
      double_faults: m.loserStats.doubleFaults,
      first_serve_pct: m.loserStats.firstServePercentage,
      bp_converted: m.loserStats.breakPointsConverted,
      bp_total: m.loserStats.breakPointsTotal,
    },
    recap: null,
  }));

  const { error } = await supabaseAdmin.from("matches").upsert(rows);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ seeded: rows.length });
}
