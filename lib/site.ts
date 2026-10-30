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

// Pages de l'émission sur les plateformes — laisser "" tant qu'elle n'y est
// pas encore publiée : le bouton correspondant est alors masqué
export const LISTEN_LINKS = {
  apple: "https://podcasts.apple.com/us/podcast/tennis-daily/id6828797687",
  spotify: "https://open.spotify.com/show/3l00OmsGUoXiPJNblZPhtj",
};

// URL d'audio passée aux applis podcast : passe par /api/e pour compter
// les téléchargements, puis redirige vers le MP3 de Supabase Storage
export function trackedAudioUrl(origin: string, date: string): string {
  return `${origin}/api/e/${date}.mp3`;
}
