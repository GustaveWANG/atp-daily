import { createClient } from "@supabase/supabase-js";

// Client admin côté serveur uniquement — utilise la service role key
// Ne jamais importer ce module dans du code client-side
// Sans générique Database : les types sont castés à l'usage (DbMatch, DbEpisode depuis supabase.ts)
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
