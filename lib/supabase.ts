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

export interface DbPlayerOfDay {
  name: string;
  country: string;
  photo?: string;
  stats: {
    first_serve: number;
    aces: number;
    break_pts: string;
  };
  quote: string;
}

export interface DbInsight {
  label: string;
  value: string;
  player: string;
}

export interface DbEpisode {
  id: string;
  date: string;
  script: string | null;
  audio_url: string | null;
  audio_duration: number | null;
  chapter_titles: string[] | null;
  player_of_day: DbPlayerOfDay | null;
  insights: DbInsight[] | null;
  the_read: string | null;
  bracket_watch: string | null;
  title: string | null;
  created_at: string;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Client sans générique Database — les types manuels ci-dessus (DbMatch, DbEpisode)
// sont utilisés pour caster les résultats de requête côté application
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
