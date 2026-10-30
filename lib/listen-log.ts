// Écritures des tables feedback / listen_events (migration 003), côté serveur
// uniquement. Une erreur d'écriture ne doit jamais casser la lecture : on log
// et on continue.

export const LISTEN_EVENTS = [
  "play",
  "progress_25",
  "progress_50",
  "progress_75",
  "complete",
  "download",
] as const;
export type ListenEvent = (typeof LISTEN_EVENTS)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isEpisodeDate(s: unknown): s is string {
  return typeof s === "string" && DATE_RE.test(s);
}

// Identifiant aléatoire généré par le navigateur — on borne juste la forme
export function cleanListenerId(s: unknown): string | null {
  return typeof s === "string" && /^[A-Za-z0-9-]{8,64}$/.test(s) ? s : null;
}

export async function logListenEvent(row: {
  episode_date: string;
  event: ListenEvent;
  listener_id?: string | null;
  client_hash?: string | null;
  user_agent?: string | null;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/lib/supabase-server");
  const { error } = await supabaseAdmin.from("listen_events").insert(row);
  if (error) console.error("listen_events insert failed:", error.message);
}
