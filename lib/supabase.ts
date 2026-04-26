import { createClient } from "@supabase/supabase-js";

// Types qui reflètent la structure de la table matches en base de données
export interface DbMatchStats {
  aces: number;
  double_faults: number;
  first_serve_pct: number;
  bp_converted: number;
  bp_total: number;
}

export interface DbMatch {
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
  winner_stats: DbMatchStats;
  loser_stats: DbMatchStats;
  recap: string | null;
  created_at: string;
}

export interface DbEpisode {
  id: string;
  date: string;
  script: string;
  created_at: string;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Client sans générique Database — les types manuels ci-dessus (DbMatch, DbEpisode)
// sont utilisés pour caster les résultats de requête côté application
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
