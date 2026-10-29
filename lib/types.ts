// Types côté app pour les matchs affichés (convertis depuis DbMatch)

export type Surface = "Clay" | "Hard" | "Grass";

export interface MatchStats {
  aces: number;
  doubleFaults: number;
  firstServePercentage: number;
  breakPointsConverted: number;
  breakPointsTotal: number;
}

export interface Player {
  name: string;
  country: string;
  seed?: number;
}

export interface Match {
  id: string;
  tournament: string;
  round: string;
  surface: Surface;
  date: string;
  winner: Player;
  loser: Player;
  score: string;
  winnerStats: MatchStats;
  loserStats: MatchStats;
}
