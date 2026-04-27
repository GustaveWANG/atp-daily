// Wrapper RapidAPI ATP — API : tennis-api-atp-wta-itf.p.rapidapi.com
// Endpoints : getPlayerPastMatches + getTournamentResults
// Stratégie : utilise Alcaraz + Sinner pour trouver les tournois actifs,
//             puis récupère tous les matchs du jour via getTournamentResults

import type { Match, Surface } from "@/lib/mockData";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY!;
const RAPIDAPI_HOST = "tennis-api-atp-wta-itf.p.rapidapi.com";
const BASE_URL = `https://${RAPIDAPI_HOST}`;

// IDs candidats à tester pour chaque run — les 4 tournois les plus récents
// de la saison. À mettre à jour manuellement quand un nouveau tournoi commence.
// Coût : 4 appels getTournamentResults par run (< 130 req/mois pour 1 run/jour).
const CANDIDATE_TOURNAMENT_IDS = [21324, 21325, 21326, 21327];

// ── Types bruts API ───────────────────────────────────────────────────────────

interface RawMatch {
  id: string;
  date: string;           // "2026-04-26T00:00:00.000Z"
  roundId: number;
  player1Id: number;
  player2Id: number;
  tournamentId: number;
  match_winner: number;   // player ID du vainqueur
  result: string;         // "6-4 6-2" depuis la perspective de player1
  player1: { id: number; name: string; countryAcr: string };
  player2: { id: number; name: string; countryAcr: string };
}

interface TournamentResultsBody {
  data: {
    singles: RawMatch[];
    doubles: RawMatch[];
    qualifying: RawMatch[];
  };
}

// ── Tables de correspondance ──────────────────────────────────────────────────

// Noms connus pour les IDs de tournois déjà observés
const TOURNAMENT_NAMES: Record<number, string> = {
  21305: "Australian Open",
  21317: "Indian Wells Masters",
  21318: "Miami Open",
  21319: "Miami Open",
  21322: "Monte Carlo Masters",
  21323: "Barcelona Open",
  21324: "Grand Prix Hassan II",
  21325: "Mutua Madrid Open",
  21326: "Internazionali BNL d'Italia",
  21327: "Internazionali BNL d'Italia",
};

// Noms de rounds par roundId (common draw sizes — approximatif mais lisible)
const ROUND_MAP: Record<number, string> = {
  4: "First Round",
  5: "Second Round",
  6: "Third Round",
  7: "Round of 16",
  8: "Quarterfinal",
  9: "Quarterfinal",
  10: "Semifinal",
  11: "Semifinal",
  12: "Final",
};

// Codes pays 2 lettres → 3 lettres (l'API retourne parfois des codes courts)
const COUNTRY_MAP: Record<string, string> = {
  GB: "GBR", ES: "ESP", IT: "ITA", DE: "GER", FR: "FRA",
  NO: "NOR", DK: "DEN", AR: "ARG", CL: "CHI", CA: "CAN",
  RU: "RUS", US: "USA", AU: "AUS", RS: "SRB", GR: "GRE",
  PL: "POL", AT: "AUT", CH: "SUI", BR: "BRA", JP: "JPN",
};

// ── Utilitaires de normalisation ──────────────────────────────────────────────

function normalizeCountry(code: string): string {
  if (code.length === 3) return code;
  return COUNTRY_MAP[code.toUpperCase()] ?? code;
}

// Surface déduite du mois (correct ~90% des cas ATP)
function surfaceFromDate(dateStr: string): Surface {
  const month = parseInt(dateStr.slice(5, 7), 10);
  if (month >= 4 && month <= 5) return "Clay";
  if (month === 6 || month === 7) return "Grass";
  return "Hard";
}

// Nom du tournoi : table connue en priorité, sinon détection par date
function tournamentName(id: number, date: string): string {
  if (TOURNAMENT_NAMES[id]) return TOURNAMENT_NAMES[id];
  const month = parseInt(date.slice(5, 7), 10);
  const day = parseInt(date.slice(8, 10), 10);
  if (month === 4 && day >= 22) return "Mutua Madrid Open";
  if (month === 5 && day <= 5) return "Mutua Madrid Open";
  if (month === 5 && day >= 6 && day <= 19) return "Internazionali BNL d'Italia";
  return "ATP Tour";
}

// Convertit le score de la perspective player1 vers la perspective du vainqueur
// "6-4 3-6 7-6(5)" + winnerIsPlayer1=false → "4-6, 6-3, 6-7(5)"
function normalizeScore(result: string, winnerIsPlayer1: boolean): string {
  // Retire "ret." ou "w/o" éventuels
  const clean = result.replace(/\s+ret\.?$/i, "").replace(/\s+w\/o$/i, "").trim();
  if (winnerIsPlayer1) return clean.replace(/ /g, ", ");
  return clean
    .split(" ")
    .map((set) => {
      const m = set.match(/^(\d+)-(\d+)(\(\d+\))?$/);
      if (!m) return set;
      // Inverse les scores du set ; (TB) appartient au perdant du set → inchangé
      return m[3] ? `${m[2]}-${m[1]}${m[3]}` : `${m[2]}-${m[1]}`;
    })
    .join(", ");
}

// ── Appels API ────────────────────────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchTournamentSingles(tournamentId: number): Promise<RawMatch[]> {
  const data = await apiGet<TournamentResultsBody>(
    `/tennis/v2/atp/tournament/results/${tournamentId}`
  );
  return data?.data?.singles ?? [];
}

// ── Normalisation vers le schéma Supabase ────────────────────────────────────

// Stats vides — cette API ne fournit pas de statistiques détaillées par match
const EMPTY_STATS = {
  aces: 0,
  double_faults: 0,
  first_serve_pct: 0,
  bp_converted: 0,
  bp_total: 0,
};

function normalizeMatch(raw: RawMatch, tName: string) {
  const winnerIsPlayer1 = raw.match_winner === raw.player1Id;
  const winner = winnerIsPlayer1 ? raw.player1 : raw.player2;
  const loser = winnerIsPlayer1 ? raw.player2 : raw.player1;
  const date = raw.date.slice(0, 10);

  // Uniquement les colonnes Supabase — pas d'objets imbriqués winner/loser
  return {
    id: `atp-${raw.id}`,
    tournament: tName,
    round: ROUND_MAP[raw.roundId] ?? `Round ${raw.roundId}`,
    surface: surfaceFromDate(date),
    date,
    score: normalizeScore(raw.result, winnerIsPlayer1),
    winner_name: winner.name,
    winner_country: normalizeCountry(winner.countryAcr),
    winner_seed: null,
    loser_name: loser.name,
    loser_country: normalizeCountry(loser.countryAcr),
    loser_seed: null,
    winner_stats: EMPTY_STATS,
    loser_stats: EMPTY_STATS,
  };
}

// ── Point d'entrée public ─────────────────────────────────────────────────────

export async function fetchAndSeedMatches(
  date: string
): Promise<{ count: number; ids: string[] }> {
  const { supabaseAdmin } = await import("@/lib/supabase-server");

  // Appelle getTournamentResults pour chaque tournoi candidat (séquentiel)
  // et filtre sur la date exacte + main draw (roundId >= 4, exclut qualifying)
  const rows: ReturnType<typeof normalizeMatch>[] = [];

  for (const tid of CANDIDATE_TOURNAMENT_IDS) {
    const singles = await fetchTournamentSingles(tid);
    const dayMatches = singles.filter(
      (m) => m.date.startsWith(date) && m.roundId >= 4
    );
    for (const match of dayMatches) {
      rows.push(normalizeMatch(match, tournamentName(tid, date)));
    }
  }

  if (rows.length === 0) return { count: 0, ids: [] };

  // Étape 3 : upsert dans Supabase (onConflict: id → mise à jour si déjà présent)
  const { data, error } = await supabaseAdmin
    .from("matches")
    .upsert(rows, { onConflict: "id" })
    .select("id");

  if (error) throw new Error(`Supabase upsert error: ${error.message}`);

  const ids = (data ?? []).map((r: { id: string }) => r.id);
  return { count: ids.length, ids };
}
