import type { NextApiRequest, NextApiResponse } from "next";
import {
  LISTEN_EVENTS,
  type ListenEvent,
  isEpisodeDate,
  cleanListenerId,
  logListenEvent,
} from "@/lib/listen-log";

// POST { episode_date, event, listener_id } — envoyé par navigator.sendBeacon
// depuis le lecteur du site (le téléchargement des applis passe par /api/e)
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).end();
    return;
  }

  // sendBeacon envoie du text/plain : on parse nous-mêmes si besoin
  let body: Record<string, unknown> = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
  } catch {
    /* corps invalide → 400 ci-dessous */
  }

  const event = body.event as ListenEvent;
  if (!isEpisodeDate(body.episode_date) || !LISTEN_EVENTS.includes(event) || event === "download") {
    res.status(400).end();
    return;
  }

  await logListenEvent({
    episode_date: body.episode_date,
    event,
    listener_id: cleanListenerId(body.listener_id),
  });
  res.status(204).end();
}
