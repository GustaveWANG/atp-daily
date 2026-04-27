-- Migration 001 — Extension de la table episodes pour la V1 MVP
-- Ajoute les colonnes nécessaires au pipeline de pré-génération backend (TICKET-3)
-- À exécuter dans le SQL Editor Supabase une seule fois

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS audio_url       TEXT,
  ADD COLUMN IF NOT EXISTS audio_duration  INT,
  ADD COLUMN IF NOT EXISTS chapter_titles  JSONB,
  -- Structure : { name, country, photo?, stats: { first_serve, aces, break_pts }, quote }
  ADD COLUMN IF NOT EXISTS player_of_day   JSONB,
  -- Structure : [{ label, value, player }, ...]
  ADD COLUMN IF NOT EXISTS insights        JSONB,
  ADD COLUMN IF NOT EXISTS the_read        TEXT,
  ADD COLUMN IF NOT EXISTS bracket_watch   TEXT,
  -- Ex : "Madrid Open · April 25, 2026"
  ADD COLUMN IF NOT EXISTS title           TEXT;

-- Rendre script nullable pour permettre une insertion partielle si besoin
ALTER TABLE episodes
  ALTER COLUMN script DROP NOT NULL;
