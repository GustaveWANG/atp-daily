import type { IncomingMessage } from "http";

// URL publique du site, ex : "https://atp-daily.vercel.app"
// SITE_URL si défini (domaine canonique), sinon déduit de la requête
export function siteOrigin(req: IncomingMessage): string {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
  return `${proto}://${req.headers.host}`;
}

// Lien partageable vers un épisode précis (ouvre la page d'accueil dessus)
export function episodeLink(origin: string, date: string): string {
  return `${origin}/?ep=${date}`;
}

// URL d'audio passée aux applis podcast : passe par /api/e pour compter
// les téléchargements, puis redirige vers le MP3 de Supabase Storage
export function trackedAudioUrl(origin: string, date: string): string {
  return `${origin}/api/e/${date}.mp3`;
}
