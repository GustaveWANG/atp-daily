import type { GetServerSideProps } from "next";
import { siteOrigin, episodeLink, trackedAudioUrl } from "@/lib/site";

// Flux RSS podcast (Apple Podcasts, Spotify, Pocket Casts, Overcast…)
// Spécification suivie : https://podcasters.apple.com/support/823-podcast-requirements

const SHOW_TITLE = "Tennis Daily";
const SHOW_DESCRIPTION =
  "A short daily conversation about the ATP tour: yesterday's results, the " +
  "storylines behind them, and how the players played it. Written and voiced " +
  "with AI from verified match data, published every morning during the season. " +
  "Not affiliated with the ATP Tour.";

interface FeedRow {
  date: string;
  title: string | null;
  headline: string | null;
  audio_url: string | null;
  audio_duration: number | null;
  chapter_titles: string[] | null;
  created_at: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Taille du MP3 en octets, exigée par <enclosure length>. 0 si inconnue :
// les applis l'acceptent, elles relisent la vraie taille au téléchargement.
async function audioBytes(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return Number(res.headers.get("content-length")) || 0;
  } catch {
    return 0;
  }
}

function episodeDescription(ep: FeedRow): string {
  const parts: string[] = [];
  if (ep.headline) parts.push(ep.headline);
  if (ep.chapter_titles?.length) {
    parts.push("In this episode: " + ep.chapter_titles.join(" · "));
  }
  parts.push("AI-generated from verified match data. Spotted a mistake? Tell us on the episode page.");
  return parts.join("\n\n");
}

function buildFeed(origin: string, episodes: Array<FeedRow & { bytes: number }>): string {
  const cover = `${origin}/podcast-cover.png`;
  const ownerEmail = process.env.PODCAST_OWNER_EMAIL;

  const items = episodes
    .map((ep) => {
      const title = ep.title ?? `Episode of ${ep.date}`;
      const desc = episodeDescription(ep);
      return `    <item>
      <title>${esc(title)}</title>
      <description>${esc(desc)}</description>
      <itunes:summary>${esc(desc)}</itunes:summary>
      <link>${esc(episodeLink(origin, ep.date))}</link>
      <guid isPermaLink="false">atp-daily-${ep.date}</guid>
      <pubDate>${new Date(ep.created_at).toUTCString()}</pubDate>
      <enclosure url="${esc(trackedAudioUrl(origin, ep.date))}" length="${ep.bytes}" type="audio/mpeg"/>
${ep.audio_duration ? `      <itunes:duration>${ep.audio_duration}</itunes:duration>\n` : ""}      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SHOW_TITLE}</title>
    <link>${origin}/</link>
    <atom:link href="${origin}/feed.xml" rel="self" type="application/rss+xml"/>
    <description>${esc(SHOW_DESCRIPTION)}</description>
    <itunes:summary>${esc(SHOW_DESCRIPTION)}</itunes:summary>
    <language>en</language>
    <copyright>© ${new Date().getUTCFullYear()} ${SHOW_TITLE}</copyright>
    <itunes:author>${SHOW_TITLE}</itunes:author>
${ownerEmail ? `    <itunes:owner>\n      <itunes:name>${SHOW_TITLE}</itunes:name>\n      <itunes:email>${esc(ownerEmail)}</itunes:email>\n    </itunes:owner>\n` : ""}    <itunes:image href="${cover}"/>
    <image>
      <url>${cover}</url>
      <title>${SHOW_TITLE}</title>
      <link>${origin}/</link>
    </image>
    <itunes:category text="Sports">
      <itunes:category text="Tennis"/>
    </itunes:category>
    <itunes:explicit>false</itunes:explicit>
    <itunes:type>episodic</itunes:type>
${items}
  </channel>
</rss>
`;
}

// Page sans rendu React : getServerSideProps écrit directement le XML
export default function Feed() {
  return null;
}

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  const { supabaseAdmin } = await import("@/lib/supabase-server");

  const { data, error } = await supabaseAdmin
    .from("episodes")
    .select("date, title, headline, audio_url, audio_duration, chapter_titles, created_at")
    .not("audio_url", "is", null)
    .order("date", { ascending: false })
    .limit(100);

  if (error) {
    // Pas de flux vide : les applis supprimeraient tous les épisodes
    console.error("Feed data load failed:", error.message);
    res.statusCode = 503;
    res.end();
    return { props: {} };
  }

  const rows = (data ?? []) as FeedRow[];
  const episodes = await Promise.all(
    rows.map(async (ep) => ({ ...ep, bytes: await audioBytes(ep.audio_url!) }))
  );

  res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
  // Les applis repassent souvent ; un nouvel épisode arrive une fois par jour
  res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
  res.write(buildFeed(siteOrigin(req), episodes));
  res.end();
  return { props: {} };
};
