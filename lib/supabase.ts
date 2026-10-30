// Types qui reflètent les tables matches / episodes ; les requêtes passent par
// supabaseAdmin (lib/supabase-server.ts), côté serveur uniquement
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
  headline: string | null;
  created_at: string;
}
