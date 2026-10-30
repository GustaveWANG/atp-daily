-- Table principale pour les matchs ATP
-- Les stats sont stockées en JSONB pour garder la flexibilité
-- tout en permettant des requêtes structurées sur les champs individuels
CREATE TABLE IF NOT EXISTS matches (
  id                TEXT        PRIMARY KEY,
  tournament        TEXT        NOT NULL,
  round             TEXT        NOT NULL,
  surface           TEXT        NOT NULL CHECK (surface IN ('Clay', 'Hard', 'Grass')),
  date              DATE        NOT NULL,

  -- Vainqueur
  winner_name       TEXT        NOT NULL,
  winner_country    TEXT        NOT NULL,
  winner_seed       INTEGER,

  -- Perdant
  loser_name        TEXT        NOT NULL,
  loser_country     TEXT        NOT NULL,
  loser_seed        INTEGER,

  score             TEXT        NOT NULL,

  -- Statistiques de match (JSONB pour chaque joueur)
  -- Structure attendue : { aces, double_faults, first_serve_pct, bp_converted, bp_total }
  winner_stats      JSONB       NOT NULL,
  loser_stats       JSONB       NOT NULL,

  -- Récapitulatif généré par l'IA (rempli après génération)
  recap             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pour accélérer les requêtes par date (usage principal : page d'accueil)
CREATE INDEX IF NOT EXISTS matches_date_idx ON matches (date DESC);

-- Index pour accélérer les requêtes par tournoi
CREATE INDEX IF NOT EXISTS matches_tournament_idx ON matches (tournament);

-- Table des épisodes podcast quotidiens
-- Un seul épisode par date (contrainte UNIQUE sur date)
CREATE TABLE IF NOT EXISTS episodes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  date            DATE        NOT NULL UNIQUE,
  script          TEXT,
  audio_url       TEXT,
  audio_duration  INT,
  -- Tableau de titres de chapitres, ex : ["Cold open", "Alcaraz v Sinner", ...]
  chapter_titles  JSONB,
  -- { name, country, photo?, stats: { first_serve, aces, break_pts }, quote }
  player_of_day   JSONB,
  -- [{ label, value, player }, ...]
  insights        JSONB,
  the_read        TEXT,
  bracket_watch   TEXT,
  -- Ex : "Madrid Open · April 25, 2026"
  title           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS episodes_date_idx ON episodes (date DESC);

-- Lues et écrites uniquement avec la service role key (site et pipeline) :
-- RLS activé sans policy, donc la clé anon n'y a pas accès.
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
