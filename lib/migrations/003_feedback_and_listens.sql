-- Migration 003 — Retours des auditeurs et statistiques d'écoute
-- À exécuter dans le SQL Editor Supabase une seule fois
-- Les deux tables ne sont écrites que par les routes API (service role) :
-- RLS activé sans policy, donc la clé anon n'y a pas accès.

-- 👍/👎 + commentaire facultatif, laissés sous le lecteur
CREATE TABLE IF NOT EXISTS feedback (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  episode_date  DATE        NOT NULL,
  rating        SMALLINT    CHECK (rating IN (-1, 1)),
  comment       TEXT        CHECK (char_length(comment) <= 2000),
  listener_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (rating IS NOT NULL OR comment IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS feedback_episode_idx ON feedback (episode_date);
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Événements d'écoute
--   play / progress_25 / progress_50 / progress_75 / complete : lecteur du site
--   download : requête d'une appli podcast sur /api/e/<date>.mp3
-- listener_id : identifiant aléatoire stocké dans le navigateur (site)
-- client_hash : hash(IP + user agent + jour) pour dédoublonner les téléchargements
CREATE TABLE IF NOT EXISTS listen_events (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  episode_date  DATE        NOT NULL,
  event         TEXT        NOT NULL CHECK (event IN
                  ('play', 'progress_25', 'progress_50', 'progress_75', 'complete', 'download')),
  listener_id   TEXT,
  client_hash   TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS listen_events_episode_idx ON listen_events (episode_date, event);
ALTER TABLE listen_events ENABLE ROW LEVEL SECURITY;

-- Vue de synthèse par épisode : SELECT * FROM episode_stats;
-- downloads = clients uniques par jour (une appli fait plusieurs requêtes Range)
CREATE OR REPLACE VIEW episode_stats WITH (security_invoker = true) AS
SELECT
  e.date,
  e.title,
  (SELECT COUNT(DISTINCT client_hash) FROM listen_events l
     WHERE l.episode_date = e.date AND l.event = 'download')                 AS app_downloads,
  (SELECT COUNT(DISTINCT listener_id) FROM listen_events l
     WHERE l.episode_date = e.date AND l.event = 'play')                     AS web_plays,
  (SELECT COUNT(DISTINCT listener_id) FROM listen_events l
     WHERE l.episode_date = e.date AND l.event = 'progress_50')              AS web_half,
  (SELECT COUNT(DISTINCT listener_id) FROM listen_events l
     WHERE l.episode_date = e.date AND l.event = 'complete')                 AS web_complete,
  (SELECT COUNT(*) FROM feedback f WHERE f.episode_date = e.date AND f.rating = 1)  AS thumbs_up,
  (SELECT COUNT(*) FROM feedback f WHERE f.episode_date = e.date AND f.rating = -1) AS thumbs_down,
  (SELECT COUNT(*) FROM feedback f WHERE f.episode_date = e.date AND f.comment IS NOT NULL) AS comments
FROM episodes e
ORDER BY e.date DESC;
