// Identifiant anonyme et aléatoire du navigateur, pour compter des auditeurs
// uniques. Aucune donnée personnelle ; si le stockage est bloqué, on en
// génère un nouveau à chaque visite.

const KEY = "atp-daily:listener";

export function listenerId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function sendListenEvent(episodeDate: string, event: string): void {
  const body = JSON.stringify({ episode_date: episodeDate, event, listener_id: listenerId() });
  // sendBeacon survit à la fermeture de l'onglet, utile pour "complete"
  if (!navigator.sendBeacon?.("/api/events", body)) {
    void fetch("/api/events", { method: "POST", body, keepalive: true }).catch(() => {});
  }
}
