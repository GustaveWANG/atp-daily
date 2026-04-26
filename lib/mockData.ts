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

// Données fictives pour le Madrid Open, 25 avril 2026
export const matches: Match[] = [
  {
    id: "match-001",
    tournament: "Madrid Open",
    round: "Round of 32",
    surface: "Clay",
    date: "2026-04-25",
    winner: { name: "Carlos Alcaraz", country: "ESP", seed: 2 },
    loser: { name: "Sebastian Baez", country: "ARG" },
    score: "6-3, 6-2",
    winnerStats: {
      aces: 4,
      doubleFaults: 2,
      firstServePercentage: 68,
      breakPointsConverted: 4,
      breakPointsTotal: 6,
    },
    loserStats: {
      aces: 1,
      doubleFaults: 4,
      firstServePercentage: 57,
      breakPointsConverted: 0,
      breakPointsTotal: 3,
    },
  },
  {
    id: "match-002",
    tournament: "Madrid Open",
    round: "Round of 32",
    surface: "Clay",
    date: "2026-04-25",
    winner: { name: "Jannik Sinner", country: "ITA", seed: 1 },
    loser: { name: "Nicolas Jarry", country: "CHI" },
    score: "6-4, 7-5",
    winnerStats: {
      aces: 5,
      doubleFaults: 1,
      firstServePercentage: 71,
      breakPointsConverted: 3,
      breakPointsTotal: 5,
    },
    loserStats: {
      aces: 7,
      doubleFaults: 2,
      firstServePercentage: 63,
      breakPointsConverted: 1,
      breakPointsTotal: 4,
    },
  },
  {
    id: "match-003",
    tournament: "Madrid Open",
    round: "Round of 32",
    surface: "Clay",
    date: "2026-04-25",
    winner: { name: "Alexander Zverev", country: "GER", seed: 3 },
    loser: { name: "Alejandro Tabilo", country: "CHI" },
    score: "6-2, 6-4",
    winnerStats: {
      aces: 9,
      doubleFaults: 2,
      firstServePercentage: 72,
      breakPointsConverted: 5,
      breakPointsTotal: 7,
    },
    loserStats: {
      aces: 3,
      doubleFaults: 3,
      firstServePercentage: 61,
      breakPointsConverted: 1,
      breakPointsTotal: 4,
    },
  },
  {
    id: "match-004",
    tournament: "Madrid Open",
    round: "Round of 32",
    surface: "Clay",
    date: "2026-04-25",
    // Rune remporte le premier set mais s'incline en trois manches
    winner: { name: "Casper Ruud", country: "NOR", seed: 6 },
    loser: { name: "Holger Rune", country: "DEN", seed: 11 },
    score: "3-6, 6-3, 7-5",
    winnerStats: {
      aces: 2,
      doubleFaults: 4,
      firstServePercentage: 62,
      breakPointsConverted: 5,
      breakPointsTotal: 9,
    },
    loserStats: {
      aces: 8,
      doubleFaults: 5,
      firstServePercentage: 65,
      breakPointsConverted: 4,
      breakPointsTotal: 8,
    },
  },
  {
    id: "match-005",
    tournament: "Madrid Open",
    round: "Round of 32",
    surface: "Clay",
    date: "2026-04-25",
    winner: { name: "Lorenzo Musetti", country: "ITA", seed: 16 },
    loser: { name: "Felix Auger-Aliassime", country: "CAN", seed: 12 },
    score: "7-5, 6-4",
    winnerStats: {
      aces: 3,
      doubleFaults: 2,
      firstServePercentage: 65,
      breakPointsConverted: 3,
      breakPointsTotal: 5,
    },
    loserStats: {
      aces: 9,
      doubleFaults: 4,
      firstServePercentage: 67,
      breakPointsConverted: 2,
      breakPointsTotal: 6,
    },
  },
];
