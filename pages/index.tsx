import Head from "next/head";
import { useState, useRef, useEffect } from "react";
import type { GetServerSideProps } from "next";
import styles from "@/styles/Home.module.css";
import PodcastPlayer, {
  type PlayerHandle,
  type PlayerState,
} from "@/components/PodcastPlayer";
import MiniPlayer from "@/components/MiniPlayer";
import EpisodeFeedback from "@/components/EpisodeFeedback";
import ListenOn, { PLATFORMS } from "@/components/ListenOn";
import { sendListenEvent } from "@/lib/listener";
import { siteOrigin, episodeLink } from "@/lib/site";

// ── format des épisodes (chargés depuis Supabase) ────────────────────────────

interface Episode {
  date: string;                 // "2026-04-26"
  title: string;                // depuis episodes.title, fallback sur la date
  headline: string | null;
  audio_url: string | null;
  audio_duration: number | null;
  chapter_titles: string[];
}

// Formate la date "2026-04-26" en "APR 26"
function formatDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const month = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  return `${month} ${d.getUTCDate()}`;
}

// Formate la date "2026-04-26" en "Sun · Apr 26, 2026"
function formatLongDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Formate une durée en secondes vers "MM:SS"
function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Barres de waveform pour l'état sans audio
const WAVE_HEIGHTS = Array.from({ length: 48 }, (_, i) =>
  Math.round(Math.max(4, 6 + Math.abs(Math.sin(i * 0.5)) * 28))
);

// ── composant principal ───────────────────────────────────────────────────────
interface HomeProps {
  episodes: Episode[]; // du plus récent au plus ancien
  initialDate: string | null; // ?ep=2026-04-26 — lien partagé vers un épisode
  origin: string;
}

// Paliers d'écoute envoyés à /api/events (fraction de la durée → événement)
const MILESTONES: Array<[number, string]> = [
  [0.25, "progress_25"],
  [0.5, "progress_50"],
  [0.75, "progress_75"],
  [0.95, "complete"],
];

export default function Home({ episodes, initialDate, origin }: HomeProps) {
  const latest = episodes[0] ?? null;

  // Épisode chargé dans le lecteur — celui du lien partagé, sinon le plus récent
  const [current, setCurrent] = useState<Episode | null>(
    episodes.find((ep) => ep.date === initialDate) ?? latest
  );
  const isLatest = current?.date === latest?.date;

  // Refs et état pour le lecteur et le mini-player
  const playerRef = useRef<PlayerHandle>(null);
  const heroRef = useRef<HTMLElement>(null);
  const [heroVisible, setHeroVisible] = useState(true);
  const [playerState, setPlayerState] = useState<PlayerState>({
    playing: false,
    currentTime: 0,
    duration: 0,
  });

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

  // Statistiques d'écoute : un "play" puis chaque palier, une fois par épisode
  // chargé (les seeks en arrière ne renvoient rien)
  const sentRef = useRef<{ date: string; events: Set<string> }>({ date: "", events: new Set() });
  useEffect(() => {
    const date = current?.date;
    if (!date) return;
    if (sentRef.current.date !== date) sentRef.current = { date, events: new Set() };
    const sent = sentRef.current.events;
    const once = (event: string) => {
      if (sent.has(event)) return;
      sent.add(event);
      sendListenEvent(date, event);
    };
    if (playerState.playing) once("play");
    if (playerState.duration > 0 && sent.has("play")) {
      const frac = playerState.currentTime / playerState.duration;
      for (const [at, event] of MILESTONES) if (frac >= at) once(event);
    }
  }, [current?.date, playerState]);

  function selectEpisode(ep: Episode) {
    setCurrent(ep);
    // L'URL suit l'épisode affiché, pour pouvoir la copier et la partager
    window.history.replaceState(null, "", ep.date === latest?.date ? "/" : `/?ep=${ep.date}`);
    heroRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const shareTitle = current && !isLatest ? `${current.title} · Tennis Daily` : "Tennis Daily";
  const shareDescription = current?.headline ?? "A daily ATP tennis podcast";

  return (
    <>
      <Head>
        <title>{shareTitle}</title>
        <meta name="description" content={shareDescription} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="alternate" type="application/rss+xml" title="Tennis Daily" href="/feed.xml" />
        {/* Aperçu des liens partagés (X/Twitter, iMessage, Slack…) */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content={shareTitle} />
        <meta property="og:description" content={shareDescription} />
        <meta property="og:image" content={`${origin}/tennis-daily-cover.jpg`} />
        {current && <meta property="og:url" content={episodeLink(origin, current.date)} />}
        <meta name="twitter:card" content="summary" />
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
            tennis:daily
          </span>
        </nav>

        {/* ── Hero — épisode en cours ── */}
        <section className={styles.hero} ref={heroRef}>
          <div className={styles.heroWordmark} aria-hidden="true">tennis:daily</div>
          <div className={styles.heroCard}>
            <div className={styles.heroTop}>
              <span className={`${styles.chip} ${isLatest ? styles.chipAccent : ""}`}>
                {isLatest ? "● LATEST EPISODE" : "PAST EPISODE"}
              </span>
              {current && <span className={styles.meta}>{formatLongDate(current.date)}</span>}
            </div>

            {current ? (
              <>
                <h1 className={styles.heroTitle}>{current.title}</h1>
                {current.headline && <p className={styles.heroSub}>{current.headline}</p>}
              </>
            ) : (
              <>
                <h1 className={styles.heroTitle}>Today&apos;s episode</h1>
                <p className={styles.heroSub}>
                  A daily conversation about the ATP tour — what happened, and how
                  the players played it.
                </p>
              </>
            )}

            {/* Lecteur complet si l'audio est disponible, sinon waveform statique */}
            {current?.audio_url ? (
              <>
              <PodcastPlayer
                key={current.date}
                src={current.audio_url}
                chapterTitles={current.chapter_titles}
                {...(current.audio_duration ? { fallbackDuration: current.audio_duration } : {})}
                onStateChange={setPlayerState}
                ref={playerRef}
              />
              <EpisodeFeedback episodeDate={current.date} />
              </>
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

        {/* ── S'abonner sur les plateformes ── */}
        <ListenOn />

        {/* ── Épisodes précédents ── */}
        <div className={styles.secH}>
          <span>All episodes</span>
        </div>
        <div className={styles.recentList}>
          {episodes.length === 0 ? (
            <p className={styles.emptyState}>No episodes yet.</p>
          ) : (
            episodes.map((ep) => {
              const active = ep.date === current?.date;
              return (
                <button
                  key={ep.date}
                  type="button"
                  className={`${styles.recentItem} ${active ? styles.recentActive : ""}`}
                  onClick={() => selectEpisode(ep)}
                  disabled={!ep.audio_url}
                >
                  <span className={styles.recentDay}>{formatDay(ep.date)}</span>
                  <span className={styles.recentTitle}>{ep.title}</span>
                  <span className={styles.recentLen}>
                    <span className={styles.recentPlay}>{active ? "●" : "▶"}</span>
                    {formatDuration(ep.audio_duration)}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* ── Footer ── */}
        <div className={styles.foot}>
          <span>TENNIS DAILY · a daily tennis podcast</span>
          <span className={styles.footLinks}>
            {PLATFORMS.map(({ key, label, href }) => (
              <a key={key} href={href} className={styles.footLink} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            ))}
            <a href="/feed.xml" className={styles.footLink}>RSS feed</a>
          </span>
        </div>

      </div>

      {/* Mini-player fixe — apparaît quand le hero sort du viewport */}
      <MiniPlayer
        visible={!heroVisible && !!current?.audio_url}
        title={current?.title ?? "Tennis Daily"}
        playing={playerState.playing}
        currentTime={playerState.currentTime}
        duration={playerState.duration}
        onPlayPause={() => playerRef.current?.togglePlayPause()}
        onSeek={(t) => playerRef.current?.seekTo(t)}
      />
    </>
  );
}

// ── chargement serveur : liste des épisodes ──────────────────────────────────
export const getServerSideProps: GetServerSideProps<HomeProps> = async ({ req, query }) => {
  const initialDate = typeof query.ep === "string" ? query.ep : null;
  const origin = siteOrigin(req);
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-server");

    const { data } = await supabaseAdmin
      .from("episodes")
      .select("date, title, headline, audio_url, audio_duration, chapter_titles")
      .order("date", { ascending: false })
      .limit(60);

    const rows = data as Array<{
      date: string;
      title: string | null;
      headline: string | null;
      audio_url: string | null;
      audio_duration: number | null;
      chapter_titles: string[] | null;
    }> | null;

    const episodes: Episode[] = (rows ?? []).map((ep) => ({
      date: ep.date,
      title: ep.title ?? `Episode of ${ep.date}`,
      headline: ep.headline,
      audio_url: ep.audio_url,
      audio_duration: ep.audio_duration,
      chapter_titles: ep.chapter_titles ?? [],
    }));

    return { props: { episodes, initialDate, origin } };
  } catch (err) {
    // Supabase inaccessible : page vide plutôt que des données inventées
    console.error("Home data load failed:", (err as Error).message);
    return { props: { episodes: [], initialDate, origin } };
  }
};
