import Head from "next/head";
import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import type { GetServerSideProps } from "next";
import { matches as mockMatches, type Match, type Surface } from "@/lib/mockData";
import styles from "@/styles/Home.module.css";
import PodcastPlayer, {
  type PlayerHandle,
  type PlayerState,
} from "@/components/PodcastPlayer";
import MiniPlayer from "@/components/MiniPlayer";
import type { DbMatch } from "@/lib/supabase";

// ── helpers ──────────────────────────────────────────────────────────────────

// Initiales à partir d'un nom complet (ex. "Carlos Alcaraz" → "CA")
function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// Parse le score "6-3, 7-5" en sets gagnant / perdant
function parseSets(score: string): { winner: string[]; loser: string[] } {
  const sets = score.split(",").map((s) => s.trim());
  return {
    winner: sets.map((s) => s.split("-")[0] ?? "—"),
    loser: sets.map((s) => s.split("-")[1] ?? "—"),
  };
}

// Extrait les deux premières lignes du script pour l'aperçu dans le hero
function scriptExcerpt(script: string): string {
  const lines = script.split("\n").filter((l) => l.trim());
  return lines.slice(0, 3).join(" ").replace(/^(ALEX|SAM):\s*/gm, "").slice(0, 160);
}

// ── drapeaux CSS gradient par code pays ──────────────────────────────────────
// valeurs sans la parenthèse fermante — elle est ajoutée dans le template JSX
const FLAG: Record<string, string> = {
  ESP: "to bottom, #aa1a1a 0 33%, #f1c20a 33% 66%, #aa1a1a 66%",
  ITA: "to right, #008c45 0 33%, #f4f9ff 33% 66%, #cd212a 66%",
  GER: "to bottom, #1a1814 0 33%, #d12a2a 33% 66%, #f0c419 66%",
  NOR: "to right, #c6363c 0 50%, #1a3a8a 50%",
  DEN: "to right, #c6363c 0 100%",
  ARG: "to bottom, #74acdf 0 33%, #ffffff 33% 66%, #74acdf 66%",
  CHI: "to bottom, #d52b1e 0 50%, #ffffff 50%",
  CAN: "to right, #c6363c 0 30%, #fff 30% 70%, #c6363c 70%",
  RUS: "to bottom, #ffffff 0 33%, #1a3a8a 33% 66%, #c6363c 66%",
  USA: "to bottom, #b22234 0 50%, #fff 50%",
  AUS: "to bottom, #0d4ea2 0 50%, #c6363c 50%",
  SRB: "to bottom, #0c4076 0 33%, #ffffff 33% 66%, #c6363c 66%",
  GRE: "to bottom, #0d4ea2 0 50%, #ffffff 50%",
  POL: "to bottom, #ffffff 0 50%, #c6363c 50%",
  FRA: "to right, #002395 0 33%, #ffffff 33% 66%, #ed2939 66%",
};

// ── épisodes récents fictifs ──────────────────────────────────────────────────
const RECENT = [
  { day: "TUE 22", title: "Madrid opens. The clay surprise nobody saw.", len: "16:42" },
  { day: "MON 21", title: "Stuttgart aftermath: a serve clinic from Tiafoe.", len: "12:08" },
  { day: "SUN 20", title: "Barcelona final — patience over power.", len: "21:30" },
  { day: "SAT 19", title: "Three setters, two retirements, one weird tiebreak.", len: "17:55" },
  { day: "FRI 18", title: "The mid-season slump nobody is talking about.", len: "14:20" },
  { day: "THU 17", title: "Estoril roundup + a young Spaniard to watch.", len: "11:46" },
];

// Barres de waveform pour l'état pré-audio (avant chargement du lecteur complet)
const WAVE_HEIGHTS = Array.from({ length: 48 }, (_, i) =>
  Math.max(4, 6 + Math.abs(Math.sin(i * 0.5)) * 28)
);

// ── composant principal ───────────────────────────────────────────────────────
interface HomeProps {
  matches: Match[];
  initialRecaps: Record<string, string>;
  todayScript: string | null;
}

export default function Home({ matches, initialRecaps, todayScript }: HomeProps) {
  const [recaps, setRecaps] = useState<Record<string, string>>(initialRecaps);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [podcastScript, setPodcastScript] = useState(todayScript ?? "");
  const [podcastLoading, setPodcastLoading] = useState(false);
  const [podcastError, setPodcastError] = useState("");

  // Audio de substitution — remplacer par la génération TTS quand les crédits sont disponibles
  const [audioUrl, setAudioUrl] = useState("https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3");
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState("");
  const prevAudioUrl = useRef("");

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

  async function generateRecap(match: Match) {
    setLoading((p) => ({ ...p, [match.id]: true }));
    setErrors((p) => ({ ...p, [match.id]: "" }));
    try {
      const res = await fetch("/api/recap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(match),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { recap?: string; error?: string };
      if (data.error) throw new Error(data.error);
      setRecaps((p) => ({ ...p, [match.id]: data.recap ?? "" }));
      setExpanded((p) => ({ ...p, [match.id]: true }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setErrors((p) => ({ ...p, [match.id]: msg }));
    } finally {
      setLoading((p) => ({ ...p, [match.id]: false }));
    }
  }

  async function generatePodcast() {
    setPodcastLoading(true);
    setPodcastError("");
    try {
      const res = await fetch("/api/podcast", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { script?: string; error?: string };
      if (data.error) throw new Error(data.error);
      setPodcastScript(data.script ?? "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setPodcastError(msg);
    } finally {
      setPodcastLoading(false);
    }
  }

  async function generateAudio() {
    if (!podcastScript) return;
    setTtsLoading(true);
    setTtsError("");
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: podcastScript }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      // Fallback quand la clé ElevenLabs n'est pas configurée
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const data = (await res.json()) as { fallbackUrl?: string };
        if (data.fallbackUrl) {
          setAudioUrl(data.fallbackUrl);
          return;
        }
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (prevAudioUrl.current) URL.revokeObjectURL(prevAudioUrl.current);
      prevAudioUrl.current = url;
      setAudioUrl(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setTtsError(msg);
    } finally {
      setTtsLoading(false);
    }
  }

  function handlePlayBtn() {
    if (!podcastScript) {
      generatePodcast();
    } else if (!audioUrl) {
      generateAudio();
    }
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

  // joueur avec le plus d'aces = Player of the Day
  const potd = matches.reduce((best, m) =>
    m.winnerStats.aces > best.winnerStats.aces ? m : best
  );

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
            <div className={styles.stripVal}>SAT · APR 25</div>
          </div>
          <div className={`${styles.stripCell} ${styles.stripCenter}`}>
            <div className={styles.stripKey}>Tournament:</div>
            <div className={styles.stripVal}>MADRID OPEN · R32</div>
          </div>
          <div className={`${styles.stripCell} ${styles.stripRight}`}>
            <div className={styles.stripKey}>Surface:</div>
            <div className={styles.stripVal}>CLAY · OUTDOOR</div>
          </div>
        </div>

        {/* ── Hero — podcast du jour ── */}
        <section className={styles.hero} ref={heroRef}>
          <div className={styles.heroWordmark} aria-hidden="true">atp:daily</div>
          <div className={styles.heroCard}>
            <div className={styles.heroTop}>
              <span className={`${styles.chip} ${styles.chipAccent}`}>
                ● TODAY&apos;S EPISODE · EP 118
              </span>
              <span className={styles.meta}>
                Apr 25 · Madrid Open · {matches.length} matches
              </span>
            </div>

            {podcastScript ? (
              <>
                <h1 className={styles.heroTitle}>
                  Today&apos;s daily ATP recap — generated by AI.
                </h1>
                <p className={styles.heroSub}>{scriptExcerpt(podcastScript)}…</p>
                <div className={styles.heroChapters}>
                  <span className={styles.heroCh}>00:00 · Cold open</span>
                  {matches.slice(0, 3).map((m, i) => (
                    <span key={i} className={styles.heroCh}>
                      {String(i * 4 + 2).padStart(2, "0")}:00 ·{" "}
                      {m.winner.name.split(" ").slice(-1)[0]} vs{" "}
                      {m.loser.name.split(" ").slice(-1)[0]}
                    </span>
                  ))}
                  <span className={styles.heroCh}>
                    {String(matches.length * 3 + 2).padStart(2, "0")}:00 · Tomorrow&apos;s order of play
                  </span>
                </div>
              </>
            ) : (
              <>
                <h1 className={styles.heroTitle}>
                  {podcastLoading
                    ? "Building your episode…"
                    : "Generate today's episode →"}
                </h1>
                <p className={styles.heroSub}>
                  An audio recap of every ATP match today — generated after the
                  last point, narrated end to end by AI.
                </p>
                {!podcastLoading && (
                  <button
                    className={styles.generateEpisodeBtn}
                    onClick={generatePodcast}
                    disabled={podcastLoading}
                  >
                    Generate Daily Podcast Script
                  </button>
                )}
              </>
            )}

            {podcastError && (
              <p className={styles.heroError}>{podcastError}</p>
            )}

            {/* Lecteur complet quand l'audio est prêt, sinon contrôles simples */}
            {audioUrl ? (
              <PodcastPlayer
                src={audioUrl}
                chapterTitles={CHAPTER_TITLES}
                onStateChange={setPlayerState}
                ref={playerRef}
              />
            ) : (
              <div className={styles.heroBottom}>
                <button
                  className={styles.playBtn}
                  onClick={handlePlayBtn}
                  disabled={podcastLoading || ttsLoading}
                  aria-label="Play episode"
                >
                  {ttsLoading ? "⏳" : "▶"}
                </button>
                <div className={styles.wave}>
                  {WAVE_HEIGHTS.map((h, i) => (
                    <div key={i} style={{ height: h }} />
                  ))}
                </div>
                <span className={styles.timeTag}>
                  {podcastScript ? "Click ▶ for audio" : "18:30"}
                </span>
              </div>
            )}

            {ttsError && <p className={styles.heroError}>{ttsError}</p>}
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
          {matches.map((match) => {
            const sets = parseSets(match.score);
            const isExpanded = expanded[match.id];
            return (
              <div key={match.id} className={styles.matchCard}>
                {/* Score + joueurs — cliquable vers la page de détail */}
                <Link href={`/matches/${match.id}`} className={styles.matchLink}>
                  <div className={styles.matchMeta}>
                    <span>{match.round.replace("Round of ", "R")}</span>
                    <span>·</span>
                    <span>{match.surface}</span>
                    <span className={styles.matchStatus}>FINAL</span>
                  </div>

                  {/* ligne gagnant */}
                  <div className={`${styles.matchRow} ${styles.winnerRow}`}>
                    <span className={styles.avatar}>{initials(match.winner.name)}</span>
                    <span
                      className={styles.flag}
                      style={{
                        background: `linear-gradient(${FLAG[match.winner.country] ?? "to right, #888 0 100%"})`,
                      }}
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
                    <span className={styles.avatar}>{initials(match.loser.name)}</span>
                    <span
                      className={styles.flag}
                      style={{
                        background: `linear-gradient(${FLAG[match.loser.country] ?? "to right, #888 0 100%"})`,
                      }}
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

                <button
                  className={styles.recapBtn}
                  onClick={() => {
                    if (recaps[match.id]) {
                      setExpanded((p) => ({ ...p, [match.id]: !isExpanded }));
                    } else {
                      generateRecap(match);
                    }
                  }}
                  disabled={loading[match.id]}
                >
                  {loading[match.id]
                    ? "Generating…"
                    : recaps[match.id]
                    ? isExpanded
                      ? "▲ Hide recap"
                      : "▼ Show recap"
                    : "Generate Recap"}
                </button>

                {errors[match.id] && (
                  <p className={styles.cardError}>{errors[match.id]}</p>
                )}

                {isExpanded && recaps[match.id] && (
                  <div className={styles.recapBox}>
                    {recaps[match.id].split("\n\n").map((para, i) => (
                      <p key={i}>{para}</p>
                    ))}
                  </div>
                )}
              </div>
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
          </div>

          <div className={styles.recent}>
            <div className={styles.recentH}>
              <h3>Recent episodes</h3>
              <span className={styles.meta}>last 7 days</span>
            </div>
            <div className={styles.recentList}>
              {RECENT.map((ep, i) => (
                <div key={i} className={styles.recentItem}>
                  <span className={styles.recentDay}>{ep.day}</span>
                  <span className={styles.recentTitle}>{ep.title}</span>
                  <span className={styles.recentLen}>
                    <span className={styles.recentPlay}>▶</span>
                    {ep.len}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Insights ── */}
        <div className={styles.secH}>
          <span>Insights · what today meant</span>
        </div>
        <div className={styles.insGrid}>
          <div className={styles.insStat}>
            <div className={styles.insNum}>
              {Math.max(...matches.map((m) => m.winnerStats.firstServePercentage))}%
            </div>
            <div className={styles.insLbl}>Highest 1st-serve % today</div>
            <div className={styles.insWho}>
              —{" "}
              {
                matches.reduce((best, m) =>
                  m.winnerStats.firstServePercentage >
                  best.winnerStats.firstServePercentage
                    ? m
                    : best
                ).winner.name
              }
            </div>
          </div>

          <div className={styles.insStat}>
            <div className={styles.insNum}>
              +{Math.max(...matches.map((m) => m.winnerStats.aces - m.loserStats.aces))}
            </div>
            <div className={styles.insLbl}>Ace differential (best match)</div>
            <div className={styles.insWho}>
              —{" "}
              {
                matches.reduce((best, m) =>
                  m.winnerStats.aces - m.loserStats.aces >
                  best.winnerStats.aces - best.loserStats.aces
                    ? m
                    : best
                ).winner.name
              }
            </div>
          </div>

          <div className={styles.insTake}>
            <div className={styles.insEyebrow}>● THE READ</div>
            <h4>Clay is back. The top seeds look untouchable early in Madrid.</h4>
            <p>
              Three of five matches went in straight sets. Both Alcaraz and
              Sinner dominated from the baseline — expect deep runs for the top
              half of the draw.
            </p>
            <div className={styles.byline}>— ATP Daily, editor&apos;s note</div>
          </div>

          <div className={styles.insTake}>
            <div className={styles.insEyebrow}>● BRACKET WATCH</div>
            <h4>Ruud beats Rune in three. The bottom half is wide open.</h4>
            <p>
              Rune&apos;s early exit removes a dangerous floater. Ruud looks
              set for a quarter-final clash with Alcaraz — a rematch the
              draw needed.
            </p>
            <div className={styles.byline}>— ATP Daily, bracket watch</div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className={styles.foot}>
          <span>ATP DAILY · Madrid Open · April 25, 2026</span>
          <span>↓ subscribe to the daily episode</span>
        </div>

      </div>

      {/* Mini-player fixe — apparaît quand le hero sort du viewport */}
      <MiniPlayer
        visible={!heroVisible && !!audioUrl}
        title="Today's Episode · EP 118 · Madrid Open"
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
  const today = "2026-04-25";
  try {
    // Import dynamique à l'intérieur du try — toute erreur (module, réseau) → fallback mockData
    const { supabaseAdmin } = await import("@/lib/supabase-server");
    const [{ data: rawMatches }, { data: rawEpisode }] = await Promise.all([
      supabaseAdmin
        .from("matches")
        .select("*")
        .eq("date", today)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("episodes")
        .select("script")
        .eq("date", today)
        .maybeSingle(),
    ]);

    const dbMatches = rawMatches as DbMatch[] | null;
    const dbEpisode = rawEpisode as { script: string } | null;

    const loadedMatches =
      dbMatches && dbMatches.length > 0
        ? dbMatches.map(dbMatchToMatch)
        : mockMatches;

    const initialRecaps: Record<string, string> = {};
    if (dbMatches) {
      for (const m of dbMatches) {
        if (m.recap) initialRecaps[m.id] = m.recap;
      }
    }

    return {
      props: {
        matches: loadedMatches,
        initialRecaps,
        todayScript: dbEpisode?.script ?? null,
      },
    };
  } catch {
    // Fallback sur les données mock si Supabase est inaccessible
    return {
      props: { matches: mockMatches, initialRecaps: {}, todayScript: null },
    };
  }
};
