import Head from "next/head";
import Link from "next/link";
import { useState } from "react";
import type { GetServerSideProps } from "next";
import { matches as mockMatches, type Match, type Surface, type MatchStats } from "@/lib/mockData";
import type { DbMatch } from "@/lib/supabase";
import { flagBackground } from "@/lib/flags";
import styles from "@/styles/Match.module.css";

// Parse le score "6-3, 7-5" en tableaux de sets pour chaque joueur
function parseSets(score: string): { winner: string[]; loser: string[] } {
  const sets = score.split(",").map((s) => s.trim());
  return {
    winner: sets.map((s) => s.split("-")[0] ?? "—"),
    loser: sets.map((s) => s.split("-")[1] ?? "—"),
  };
}

// Statistiques standard affichées dans la comparaison
const STAT_ROWS: Array<{
  key: keyof MatchStats;
  label: string;
  fmt: (v: number) => string;
}> = [
  { key: "aces", label: "Aces", fmt: (v) => String(v) },
  { key: "doubleFaults", label: "Double Faults", fmt: (v) => String(v) },
  { key: "firstServePercentage", label: "1st Serve %", fmt: (v) => `${v}%` },
];

// Largeur de barre proportionnelle en pourcentage (0–100)
function barPct(val: number, other: number): number {
  const max = Math.max(val, other, 1);
  return Math.round((val / max) * 100);
}

interface Props {
  match: Match;
  initialRecap: string;
}

export default function MatchDetail({ match, initialRecap }: Props) {
  const [recap, setRecap] = useState(initialRecap);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(Boolean(initialRecap));

  const sets = parseSets(match.score);

  const dateFormatted = new Date(match.date).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  async function generateRecap() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/recap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(match),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { recap?: string; error?: string };
      if (data.error) throw new Error(data.error);
      setRecap(data.recap ?? "");
      setExpanded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Head>
        <title>
          {match.winner.name} vs {match.loser.name} — ATP Daily
        </title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className={styles.page}>

        {/* ── Navigation ── */}
        <nav className={styles.nav}>
          <Link href="/" className={styles.logo}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M2.5 9 Q12 14 21.5 9" />
              <path d="M2.5 15 Q12 10 21.5 15" />
            </svg>
            atp:daily
          </Link>
          <Link href="/" className={styles.backBtn}>← Back to today</Link>
        </nav>

        {/* ── En-tête : tournoi, round, surface, date ── */}
        <header className={styles.header}>
          <div className={styles.headerMeta}>
            <span className={styles.tournament}>{match.tournament}</span>
            <span className={styles.dot}>·</span>
            <span>{match.round}</span>
            <span className={styles.dot}>·</span>
            <span className={styles.surface}>{match.surface}</span>
          </div>
          <div className={styles.headerDate}>{dateFormatted}</div>
          <div className={styles.statusBadge}>FINAL</div>
        </header>

        {/* ── Hero score : deux joueurs, drapeaux, sets ── */}
        <section className={styles.scoreHero}>

          {/* Ligne gagnant */}
          <div className={`${styles.playerRow} ${styles.winnerRow}`}>
            <div className={styles.playerInfo}>
              <span
                className={styles.flagEl}
                style={{ background: flagBackground(match.winner.country) }}
              />
              <div className={styles.playerName}>
                <span className={styles.fullName}>
                  {match.winner.name}
                  {match.winner.seed && (
                    <span className={styles.seed}> [{match.winner.seed}]</span>
                  )}
                </span>
                <span className={styles.country}>{match.winner.country}</span>
              </div>
            </div>
            <div className={styles.sets}>
              {sets.winner.map((s, i) => {
                const won = parseInt(s) > parseInt(sets.loser[i] ?? "0");
                return (
                  <span
                    key={i}
                    className={`${styles.set} ${won ? styles.setWon : styles.setLost}`}
                  >
                    {s}
                  </span>
                );
              })}
              <span className={styles.winMark}>▸</span>
            </div>
          </div>

          <div className={styles.vsLine}>
            <span className={styles.vsDivider} />
            <span className={styles.vsText}>vs</span>
            <span className={styles.vsDivider} />
          </div>

          {/* Ligne perdant */}
          <div className={styles.playerRow}>
            <div className={styles.playerInfo}>
              <span
                className={styles.flagEl}
                style={{ background: flagBackground(match.loser.country) }}
              />
              <div className={styles.playerName}>
                <span className={styles.fullName}>
                  {match.loser.name}
                  {match.loser.seed && (
                    <span className={styles.seed}> [{match.loser.seed}]</span>
                  )}
                </span>
                <span className={styles.country}>{match.loser.country}</span>
              </div>
            </div>
            <div className={styles.sets}>
              {sets.loser.map((s, i) => {
                const won = parseInt(s) > parseInt(sets.winner[i] ?? "0");
                return (
                  <span
                    key={i}
                    className={`${styles.set} ${won ? styles.setWon : styles.setLost}`}
                  >
                    {s}
                  </span>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── Comparaison des stats : barres horizontales bilatérales ── */}
        <section className={styles.statsSection}>
          <h2 className={styles.sectionTitle}>Stats Comparison</h2>
          <div className={styles.statsGrid}>

            {/* En-tête avec les noms des joueurs */}
            <div className={styles.statsHeader}>
              <span className={styles.statsHeaderWinner}>
                {match.winner.name.split(" ").slice(-1)[0]}
              </span>
              <span />
              <span className={styles.statsHeaderLoser}>
                {match.loser.name.split(" ").slice(-1)[0]}
              </span>
            </div>

            {/* Lignes de stats standard */}
            {STAT_ROWS.map(({ key, label, fmt }) => {
              const wVal = match.winnerStats[key] as number;
              const lVal = match.loserStats[key] as number;
              return (
                <div key={key} className={styles.statRow}>
                  <div className={styles.statLeft}>
                    <span className={styles.statVal}>{fmt(wVal)}</span>
                    <div className={styles.barWrapLeft}>
                      <div className={styles.bar} style={{ width: `${barPct(wVal, lVal)}%` }} />
                    </div>
                  </div>
                  <div className={styles.statLabel}>{label}</div>
                  <div className={styles.statRight}>
                    <div className={styles.barWrapRight}>
                      <div className={styles.barLoser} style={{ width: `${barPct(lVal, wVal)}%` }} />
                    </div>
                    <span className={styles.statVal}>{fmt(lVal)}</span>
                  </div>
                </div>
              );
            })}

            {/* Ligne Break Points — affichage X/Y, barre sur les conversions */}
            <div className={styles.statRow}>
              <div className={styles.statLeft}>
                <span className={styles.statVal}>
                  {match.winnerStats.breakPointsConverted}/{match.winnerStats.breakPointsTotal}
                </span>
                <div className={styles.barWrapLeft}>
                  <div
                    className={styles.bar}
                    style={{
                      width: `${barPct(
                        match.winnerStats.breakPointsConverted,
                        match.loserStats.breakPointsConverted
                      )}%`,
                    }}
                  />
                </div>
              </div>
              <div className={styles.statLabel}>Break Points</div>
              <div className={styles.statRight}>
                <div className={styles.barWrapRight}>
                  <div
                    className={styles.barLoser}
                    style={{
                      width: `${barPct(
                        match.loserStats.breakPointsConverted,
                        match.winnerStats.breakPointsConverted
                      )}%`,
                    }}
                  />
                </div>
                <span className={styles.statVal}>
                  {match.loserStats.breakPointsConverted}/{match.loserStats.breakPointsTotal}
                </span>
              </div>
            </div>

          </div>
        </section>

        {/* ── Récapitulatif IA — collapsible, appel à /api/recap ── */}
        <section className={styles.recapSection}>
          <div className={styles.recapHeader}>
            <h2 className={styles.sectionTitle}>Match Recap</h2>
            {recap && (
              <button
                className={styles.toggleBtn}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "▲ Collapse" : "▼ Expand"}
              </button>
            )}
          </div>

          {!recap && (
            <button
              className={styles.generateBtn}
              onClick={generateRecap}
              disabled={loading}
            >
              {loading ? "Generating recap…" : "Generate AI Recap"}
            </button>
          )}

          {error && <p className={styles.errorMsg}>{error}</p>}

          {expanded && recap && (
            <div className={styles.recapBody}>
              {recap.split("\n\n").map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
          )}
        </section>

        {/* ── Footer ── */}
        <footer className={styles.foot}>
          <span>
            {match.tournament} · {match.round}
          </span>
          <Link href="/" className={styles.footBack}>
            ← All matches
          </Link>
        </footer>

      </div>
    </>
  );
}

// Conversion d'une ligne Supabase vers le type Match attendu par le composant
function dbMatchToMatch(m: DbMatch): Match {
  return {
    id: m.id,
    tournament: m.tournament,
    round: m.round,
    surface: m.surface as Surface,
    date: m.date,
    winner: {
      name: m.winner_name,
      country: m.winner_country,
      ...(m.winner_seed !== null ? { seed: m.winner_seed } : {}),
    },
    loser: {
      name: m.loser_name,
      country: m.loser_country,
      ...(m.loser_seed !== null ? { seed: m.loser_seed } : {}),
    },
    score: m.score,
    winnerStats: {
      aces: m.winner_stats.aces,
      doubleFaults: m.winner_stats.double_faults,
      firstServePercentage: m.winner_stats.first_serve_pct,
      breakPointsConverted: m.winner_stats.bp_converted,
      breakPointsTotal: m.winner_stats.bp_total,
    },
    loserStats: {
      aces: m.loser_stats.aces,
      doubleFaults: m.loser_stats.double_faults,
      firstServePercentage: m.loser_stats.first_serve_pct,
      breakPointsConverted: m.loser_stats.bp_converted,
      breakPointsTotal: m.loser_stats.bp_total,
    },
  };
}

export const getServerSideProps: GetServerSideProps<Props> = async ({ params }) => {
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id;
  if (!id) return { notFound: true };

  // Tentative de chargement depuis Supabase ; fallback sur les mocks si indisponible
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-server");
    const { data } = await supabaseAdmin
      .from("matches")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (data) {
      const dbMatch = data as DbMatch;
      return {
        props: {
          match: dbMatchToMatch(dbMatch),
          initialRecap: dbMatch.recap ?? "",
        },
      };
    }
  } catch {
    // Supabase indisponible : on retombe sur les mocks ci-dessous
  }

  const mock = mockMatches.find((m) => m.id === id);
  if (!mock) return { notFound: true };
  return { props: { match: mock, initialRecap: "" } };
};
