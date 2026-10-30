# Tennis Daily

A daily AI-generated tennis podcast. Every morning a pipeline picks up
yesterday's ATP results, researches the stories worth telling, writes a
two-host script, voices it, and publishes it to a website and podcast feed.

Listen on [Apple Podcasts](https://podcasts.apple.com/us/podcast/tennis-daily/id6828797687)
or [Spotify](https://open.spotify.com/show/3l00OmsGUoXiPJNblZPhtj).

## How it works

```
discover → validate → plan → write → review → produce → publish
```

- **discover**: pulls finished matches from the tennis API, and a research agent
  reads analysis and commentary on the web.
- **validate**: hard checks on scores and stats; rare-but-valid values are
  flagged and verified. The result is a fact sheet every claim must cite.
- **plan / write / review**: an editor picks the storylines, writers draft the
  script, and a separate reviewer model sends it back until it passes.
- **produce**: ElevenLabs voices each line, speech-to-text checks the take, and
  ffmpeg stitches the episode.
- **publish**: uploads the audio and episode to Supabase, where the site reads it.

More in [docs/agentic-rebuild-design.md](docs/agentic-rebuild-design.md).

## Layout

| Path | What |
| --- | --- |
| `pipeline/` | Python pipeline (`atp_pipeline/`, prompts, evals, `scripts/run_step.py`) |
| `pages/`, `components/`, `lib/`, `styles/` | Next.js website and RSS feed (`/feed.xml`) |
| `lib/schema.sql`, `lib/migrations/` | Supabase schema |
| `.github/workflows/daily-episode.yml` | Daily scheduled run |

## Running it

You need accounts for [RapidAPI](https://rapidapi.com) (tennis data),
[Tavily](https://tavily.com), [ElevenLabs](https://elevenlabs.io) and
[Supabase](https://supabase.com). Model calls go through the
[Claude Code](https://claude.com/claude-code) CLI by default.

### Database

In the Supabase SQL editor, run `lib/schema.sql`, then the files in
`lib/migrations/` in order. Create a public Storage bucket named `audio`.

### Pipeline

```bash
cd pipeline
cp .env.example .env   # fill in the keys
uv run python scripts/run_step.py discover validate plan write review produce publish --date 2026-10-27
```

`produce` needs ffmpeg. Each step writes to `pipeline/data/runs/<date>/`, so
any step can be rerun on its own.

### Website

```bash
cp .env.example .env.local   # fill in the Supabase URL and service role key
npm install
npm run dev
```

### Scheduled runs

The GitHub Actions workflow runs the pipeline every morning. Add the secrets
listed at the top of `.github/workflows/daily-episode.yml` to your fork.

## Security

Never commit `.env`, `.env.local` or any key. The Supabase service role key is
used server-side only; tables have row level security on with no policies, so
the anon key can't read or write them.

## License

[MIT](LICENSE)
