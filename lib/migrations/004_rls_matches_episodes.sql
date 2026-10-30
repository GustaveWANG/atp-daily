-- Migration 004 — RLS sur les tables principales
-- À exécuter dans le SQL Editor Supabase une seule fois
-- Le site et le pipeline lisent et écrivent avec la service role key, qui
-- contourne RLS : RLS activé sans policy, donc la clé anon n'y a pas accès.

ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
