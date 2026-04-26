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
