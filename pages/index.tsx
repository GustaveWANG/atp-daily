import Head from "next/head";
import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import type { GetServerSideProps } from "next";
import type { Match, Surface } from "@/lib/types";
import styles from "@/styles/Home.module.css";
import PodcastPlayer, {
  type PlayerHandle,
  type PlayerState,
} from "@/components/PodcastPlayer";
import MiniPlayer from "@/components/MiniPlayer";
import type { DbMatch } from "@/lib/supabase";
import { flagBackground } from "@/lib/flags";

// ── helpers ──────────────────────────────────────────────────────────────────

// Parse le score "6-3, 7-5" en sets gagnant / perdant
function parseSets(score: string): { winner: string[]; loser: string[] } {
  const sets = score.split(",").map((s) => s.trim());
  return {
    winner: sets.map((s) => s.split("-")[0] ?? "—"),
    loser: sets.map((s) => s.split("-")[1] ?? "—"),
  };
}

// ── format des épisodes récents (chargés depuis Supabase) ────────────────────

interface RecentEpisode {
  date: string;        // "2026-04-26"
  day: string;         // "SUN 26"
  title: string;       // depuis episodes.title, fallback sur la date
  len: string;         // "16:42" ou "—"
  audio_url: string | null;
}

// Formate la date "2026-04-26" en "SUN 26"
function formatDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const dayName = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toUpperCase();
  const dayNum = d.getUTCDate();
  return `${dayName} ${dayNum}`;
}

// Formate une durée en secondes vers "MM:SS"
function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Barres de waveform pour l'état pré-audio (avant chargement du lecteur complet)
const WAVE_HEIGHTS = Array.from({ length: 48 }, (_, i) =>
  Math.round(Math.max(4, 6 + Math.abs(Math.sin(i * 0.5)) * 28))
);

// ── composant principal ───────────────────────────────────────────────────────
interface HomeProps {
  matches: Match[];
  todayScript: string | null;
  todayAudioUrl: string | null;
  todayAudioDuration: number | null;
  todayHeadline: string | null;
  todayRead: string | null;
  todayBracketWatch: string | null;
  recentEpisodes: RecentEpisode[];
  displayDate: string; // "2026-04-26" — date du jour affiché (la plus récente avec des matchs)
}

// Format compact "SUN · APR 26"
function formatStripDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toUpperCase();
  const month = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  return `${day} · ${month} ${d.getUTCDate()}`;
}

// Format hero meta "Apr 26"
function formatHeroDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const month = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()}`;
}

// Abrège les noms de rounds ATP pour l'affichage compact
function shortRound(round: string): string {
  const map: Record<string, string> = {
    "First Round": "R1",
    "Second Round": "R2",
    "Third Round": "R3",
    "Round of 16": "R16",
    "Quarterfinal": "QF",
    "Quarterfinals": "QF",
    "Semifinal": "SF",
    "Semifinals": "SF",
    "Final": "F",
  };
  return map[round] ?? round.replace("Round of ", "R");
}

export default function Home({ matches, todayScript, todayAudioUrl, todayAudioDuration, todayHeadline, todayRead, todayBracketWatch, recentEpisodes, displayDate }: HomeProps) {
  const [podcastScript] = useState(todayScript ?? "");

  // URL audio depuis Supabase — null tant qu'aucun épisode n'a d'audio (état "Coming soon")
  const [audioUrl] = useState(todayAudioUrl);

  // Refs et état pour le lecteur et le mini-player
  const playerRef = useRef<PlayerHandle>(null);
  const heroRef = useRef<HTMLElement>(null);
  const [heroVisible, setHeroVisible] = useState(true);
  const [playerState, setPlayerState] = useState<PlayerState>({
    playing: false,
    currentTime: 0,
    duration: 0,
  });

  const stripRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver — affiche le mini-player quand le hero sort du viewport
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const observer = new IntersectionObserver(
      ([entry]) => setHeroVisible(entry?.isIntersecting ?? true),
      { threshold: 0 }
    );
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  function scrollStrip(dir: number) {
    stripRef.current?.scrollBy({ left: dir * 300, behavior: "smooth" });
  }

  // Titres des chapitres calculés depuis les matchs chargés
  const CHAPTER_TITLES = [
    "Cold open",
    ...matches.map(
      (m) =>
        `${m.winner.name.split(" ").pop() ?? ""} v ${m.loser.name.split(" ").pop() ?? ""}`
    ),
    "Order of play",
  ];

  // Meilleur match selon un critère — null si aucun match en base
  function bestBy(score: (m: Match) => number): Match | null {
    return matches.reduce<Match | null>(
      (best, m) => (best === null || score(m) > score(best) ? m : best),
      null
    );
  }

  // joueur avec le plus d'aces = Player of the Day
  const potd = bestBy((m) => m.winnerStats.aces);
  const bestFirstServe = bestBy((m) => m.winnerStats.firstServePercentage);
  const bestAceDiff = bestBy((m) => m.winnerStats.aces - m.loserStats.aces);
  const tournament = matches[0]?.tournament ?? "ATP";

  return (
    <>
      <Head>
        <title>ATP Daily</title>
        <meta name="description" content="Daily ATP tennis recaps and podcast" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className={styles.page}>

        {/* ── Nav ── */}
        <nav className={styles.nav}>
          <span className={styles.logo}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M2.5 9 Q12 14 21.5 9" />
              <path d="M2.5 15 Q12 10 21.5 15" />
            </svg>
            atp:daily
          </span>
          <div className={styles.navItems}>
            <span className={styles.active}>Today</span>
            <span>Matches</span>
            <span>Players</span>
            <span>Podcast</span>
            <span>Stats</span>
          </div>
          <div className={styles.navCta}>Sign in →</div>
        </nav>

        {/* ── Bandeau de contexte ── */}
        <div className={styles.strip}>
          <div className={styles.stripCell}>
            <div className={styles.stripKey}>Day:</div>
            <div className={styles.stripVal}>{formatStripDate(displayDate)}</div>
          </div>
          <div className={`${styles.stripCell} ${styles.stripCenter}`}>
            <div className={styles.stripKey}>Tournament:</div>
            <div className={styles.stripVal}>
              {tournament.toUpperCase()}
              {matches[0]?.round && ` · ${shortRound(matches[0].round)}`}
            </div>
          </div>
          <div className={`${styles.stripCell} ${styles.stripRight}`}>
            <div className={styles.stripKey}>Surface:</div>
            <div className={styles.stripVal}>{matches[0]?.surface.toUpperCase() ?? "—"}</div>
          </div>
        </div>

        {/* ── Hero — podcast du jour ── */}
        <section className={styles.hero} ref={heroRef}>
          <div className={styles.heroWordmark} aria-hidden="true">atp:daily</div>
          <div className={styles.heroCard}>
            <div className={styles.heroTop}>
              <span className={`${styles.chip} ${styles.chipAccent}`}>
                ● TODAY&apos;S EPISODE
              </span>
              <span className={styles.meta}>
                {formatHeroDate(displayDate)} · {tournament} · {matches.length} matches
              </span>
            </div>

            {podcastScript ? (
              <>
                <h1 className={styles.heroTitle}>
                  {todayHeadline ?? "Today's daily ATP recap — generated by AI."}
                </h1>
                <div className={styles.heroChapters}>
                  {matches.map((m, i) => (
                    <span key={i} className={styles.heroCh}>
                      {m.winner.name.split(" ").slice(-1)[0]} vs{" "}
                      {m.loser.name.split(" ").slice(-1)[0]}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h1 className={styles.heroTitle}>Today&apos;s episode</h1>
                <p className={styles.heroSub}>
                  An audio recap of every ATP match today — generated after the
                  last point, narrated end to end by AI.
                </p>
              </>
            )}

            {/* Lecteur complet si l'audio est disponible, sinon waveform statique */}
            {audioUrl ? (
              <PodcastPlayer
                src={audioUrl}
                chapterTitles={CHAPTER_TITLES}
                {...(todayAudioDuration ? { fallbackDuration: todayAudioDuration } : {})}
                onStateChange={setPlayerState}
                ref={playerRef}
              />
            ) : (
              <div className={styles.heroBottom}>
                <div className={styles.wave}>
                  {WAVE_HEIGHTS.map((h, i) => (
                    <div key={i} style={{ height: h }} />
                  ))}
                </div>
                <span className={styles.timeTag}>Coming soon</span>
              </div>
            )}
          </div>
        </section>

        {/* ── Match strip ── */}
        <div className={styles.secH}>
          <span>Live & Recent · {matches.length} matches today</span>
          <span className={styles.secR}>
            <span>See all →</span>
            <span className={styles.secArrows}>
              <span onClick={() => scrollStrip(-1)}>‹</span>
              <span onClick={() => scrollStrip(1)}>›</span>
            </span>
          </span>
        </div>

        <div className={styles.matchStrip} ref={stripRef}>
          {matches.length === 0 && (
            <p className={styles.emptyState}>No matches yet.</p>
          )}
          {matches.map((match) => {
            const sets = parseSets(match.score);
            return (
              <Link
                key={match.id}
                href={`/matches/${match.id}`}
                className={styles.matchCard}
              >
                <div className={styles.matchMeta}>
                  <span>{match.round.replace("Round of ", "R")}</span>
                  <span>·</span>
                  <span>{match.surface}</span>
                  <span className={styles.matchStatus}>FINISHED</span>
                </div>

                {/* ligne gagnant */}
                <div className={`${styles.matchRow} ${styles.winnerRow}`}>
                  <span
                    className={styles.flag}
                    style={{ background: flagBackground(match.winner.country) }}
                  />
                  <span className={styles.matchName}>
                    {match.winner.name.split(" ").slice(-1)[0]}
                    {match.winner.seed && (
                      <span className={styles.matchSeed}>[{match.winner.seed}]</span>
                    )}
                  </span>
                  <span className={styles.matchScore}>
                    {sets.winner.map((s, i) => <b key={i}>{s}</b>)}
                  </span>
                </div>

                {/* ligne perdant */}
                <div className={styles.matchRow}>
                  <span
                    className={styles.flag}
                    style={{ background: flagBackground(match.loser.country) }}
                  />
                  <span className={styles.matchName}>
                    {match.loser.name.split(" ").slice(-1)[0]}
                    {match.loser.seed && (
                      <span className={styles.matchSeed}>[{match.loser.seed}]</span>
                    )}
                  </span>
                  <span className={styles.matchScore}>
                    {sets.loser.map((s, i) => <b key={i}>{s}</b>)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>

        {/* ── Player of the Day + épisodes récents ── */}
        <div className={styles.secH}>
          <span>Player of the day · Recent episodes</span>
        </div>
        <div className={styles.row2}>
          <div className={styles.potd}>
            <div className={styles.potdEyebrow}>● PLAYER OF THE DAY</div>
            {!potd ? (
              <p className={styles.emptyState}>No player of the day yet.</p>
            ) : (
            <>
            <div className={styles.potdName}>{potd.winner.name.split(" ").slice(-1)[0]}</div>
            <div className={styles.potdTag}>
              &ldquo;{potd.winnerStats.aces} aces, {potd.winnerStats.firstServePercentage}% first serve — dominant from start to finish.&rdquo;
            </div>
            <div className={styles.potdStats}>
              <div className={styles.potdStat}>
                <b>{potd.winnerStats.firstServePercentage}%</b>
                <span>1ST SERVE</span>
              </div>
              <div className={styles.potdStat}>
                <b>{potd.winnerStats.aces}</b>
                <span>ACES</span>
              </div>
              <div className={styles.potdStat}>
                <b>{potd.winnerStats.breakPointsConverted}/{potd.winnerStats.breakPointsTotal}</b>
                <span>BREAK PTS</span>
              </div>
              <div className={styles.potdStat}>
                <b>{potd.round.replace("Round of ", "R")}</b>
                <span>ROUND</span>
              </div>
            </div>
            <div className={styles.potdPhoto}>[ player photo ]</div>
            </>
            )}
          </div>

          <div className={styles.recent}>
            <div className={styles.recentH}>
              <h3>Recent episodes</h3>
              <span className={styles.meta}>last 7 days</span>
            </div>
            <div className={styles.recentList}>
              {recentEpisodes.length === 0 ? (
                <div className={styles.recentItem}>
                  <span className={styles.recentTitle}>No previous episodes yet.</span>
                </div>
              ) : (
                recentEpisodes.map((ep) => (
                  <div key={ep.date} className={styles.recentItem}>
                    <span className={styles.recentDay}>{ep.day}</span>
                    <span className={styles.recentTitle}>{ep.title}</span>
                    <span className={styles.recentLen}>
                      <span className={styles.recentPlay}>▶</span>
                      {ep.len}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* ── Insights ── */}
        <div className={styles.secH}>
          <span>Insights · what today meant</span>
        </div>
        <div className={styles.insGrid}>
          {!bestFirstServe && !bestAceDiff && !todayRead && !todayBracketWatch && (
            <p className={styles.emptyState}>No insights yet.</p>
          )}

          {bestFirstServe && (
            <div className={styles.insStat}>
              <div className={styles.insNum}>
                {bestFirstServe.winnerStats.firstServePercentage}%
              </div>
              <div className={styles.insLbl}>Highest 1st-serve % today</div>
              <div className={styles.insWho}>— {bestFirstServe.winner.name}</div>
            </div>
          )}

          {bestAceDiff && (
            <div className={styles.insStat}>
              <div className={styles.insNum}>
                +{bestAceDiff.winnerStats.aces - bestAceDiff.loserStats.aces}
              </div>
              <div className={styles.insLbl}>Ace differential (best match)</div>
              <div className={styles.insWho}>— {bestAceDiff.winner.name}</div>
            </div>
          )}

          {todayRead && (
            <div className={styles.insTake}>
              <div className={styles.insEyebrow}>● THE READ</div>
              <p>{todayRead}</p>
              <div className={styles.byline}>— ATP Daily, editor&apos;s note</div>
            </div>
          )}

          {todayBracketWatch && (
            <div className={styles.insTake}>
              <div className={styles.insEyebrow}>● BRACKET WATCH</div>
              <p>{todayBracketWatch}</p>
              <div className={styles.byline}>— ATP Daily, bracket watch</div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className={styles.foot}>
          <span>
            ATP DAILY · {tournament} ·{" "}
            {new Date(displayDate + "T00:00:00Z").toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
              timeZone: "UTC",
            })}
          </span>
          <span>↓ subscribe to the daily episode</span>
        </div>

      </div>

      {/* Mini-player fixe — apparaît quand le hero sort du viewport */}
      <MiniPlayer
        visible={!heroVisible && !!audioUrl}
        title={`Today's Episode · ${tournament}`}
        playing={playerState.playing}
        currentTime={playerState.currentTime}
        duration={playerState.duration}
        onPlayPause={() => playerRef.current?.togglePlayPause()}
        onSeek={(t) => playerRef.current?.seekTo(t)}
      />
    </>
  );
}

// ── conversion DB → format app ────────────────────────────────────────────────
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

// ── chargement serveur : matchs + épisode du jour ────────────────────────────
export const getServerSideProps: GetServerSideProps<HomeProps> = async () => {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-server");

    // Date affichée = date la plus récente avec au moins un match en base.
    // Permet de toujours montrer du contenu réel même si le cron du jour n'a pas encore tourné.
    const { data: latestRows } = await supabaseAdmin
      .from("matches")
      .select("date")
      .order("date", { ascending: false })
      .limit(1);
    const displayDate =
      (latestRows as { date: string }[] | null)?.[0]?.date ?? today;

    const [{ data: rawMatches }, { data: rawEpisode }, { data: rawRecent }] = await Promise.all([
      supabaseAdmin
        .from("matches")
        .select("*")
        .eq("date", displayDate)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("episodes")
        .select("script, audio_url, audio_duration, headline, the_read, bracket_watch")
        .eq("date", displayDate)
        .maybeSingle(),
      // 6 derniers épisodes antérieurs au displayDate, du plus récent au plus ancien
      supabaseAdmin
        .from("episodes")
        .select("date, title, audio_url, audio_duration")
        .lt("date", displayDate)
        .order("date", { ascending: false })
        .limit(6),
    ]);

    const dbMatches = rawMatches as DbMatch[] | null;
    const dbEpisode = rawEpisode as {
      script: string | null;
      audio_url: string | null;
      audio_duration: number | null;
      headline: string | null;
      the_read: string | null;
      bracket_watch: string | null;
    } | null;
    const dbRecent = rawRecent as Array<{
      date: string;
      title: string | null;
      audio_url: string | null;
      audio_duration: number | null;
    }> | null;

    const recentEpisodes: RecentEpisode[] = (dbRecent ?? []).map((ep) => ({
      date: ep.date,
      day: formatDay(ep.date),
      title: ep.title ?? `Episode of ${ep.date}`,
      len: formatDuration(ep.audio_duration),
      audio_url: ep.audio_url,
    }));

    return {
      props: {
        matches: (dbMatches ?? []).map(dbMatchToMatch),
        todayScript: dbEpisode?.script ?? null,
        todayAudioUrl: dbEpisode?.audio_url ?? null,
        todayAudioDuration: dbEpisode?.audio_duration ?? null,
        todayHeadline: dbEpisode?.headline ?? null,
        todayRead: dbEpisode?.the_read ?? null,
        todayBracketWatch: dbEpisode?.bracket_watch ?? null,
        recentEpisodes,
        displayDate,
      },
    };
  } catch (err) {
    // Supabase inaccessible : page vide plutôt que des données inventées
    console.error("Home data load failed:", (err as Error).message);
    return {
      props: {
        matches: [],
        todayScript: null,
        todayAudioUrl: null,
        todayAudioDuration: null,
        todayHeadline: null,
        todayRead: null,
        todayBracketWatch: null,
        recentEpisodes: [],
        displayDate: today,
      },
    };
  }
};
