# Tennis Daily — Agentic Architecture Design

> Branch: `agentic-rebuild` · 2026-10-28

## Design principles

1. **Workflow first; agents only where judgment is needed.** Deterministic steps (fetching scores, validation, storage, TTS, upload) are plain code. Only "find commentary / pick storylines / write / review" goes to a model.
2. **Grounding.** Everything generated must come from a single validated Fact Sheet. Every factual claim maps to a fact id; every opinion names its source.
3. **Reflection (Evaluator–Optimizer).** Write → an independent reviewer agent gives structured feedback → revise, at most N rounds. Still failing → hand off to a human, don't publish.
4. **Explicit state machine + idempotent steps.** Every run and every step is persisted, so a run can resume from the step that failed without overwriting outputs that already succeeded.
5. **Fail loudly.** Better "no episode today" than a fake one. Every failure is logged and notified.
6. **Structured output.** Handoffs between agents use JSON Schema (tool use / structured output) + zod validation.

## Overall flow

```
  cron (once a day) / manual trigger
          │
          ▼
  Orchestrator (plain code, state machine; runs / run_steps record each step)
          │
   ① DISCOVER ── Research Agent (tool calls)
          │   • Code first pulls every finished match from the previous day
          │     (results don't depend on the agent's judgment, so none are missed)
          │   • The agent picks the matches worth talking about, then searches for and reads commentary / analysis
          │   tools: list_tournaments · get_results · get_match_stats · get_player
          │          web_search · fetch_article
          │   → JSON output: matches[] (facts) + articles[] (opinions)
          ▼
   ② VALIDATE ── Code: schema + hard rules (legal scores, consistent winner, self-consistent stats,
          │   date inside the window, no duplicates) → impossible data is blocked;
          │   rare-but-valid data is flagged as an outlier, not blocked
          │   • The Research Agent runs one targeted search per outlier → verified / unverified
          │   → Fact Sheet (every entry has a fact id and a verification status)
          │   0 matches → NO_SHOW (rest day), ends normally
          ▼
   ③ PLAN ── Editor Agent: picks 2–4 storylines → Episode Outline
          │   (chapters + the fact ids / article ids each chapter cites)
          ▼
   ④ WRITE ── Writer Agents (can run in parallel)
          │   • Recap Writer: one per match, using only that match's facts
          │   • Script Writer: ALEX / SAM dialogue following the Outline
          │   • Meta Writer: headline / title / chapters (derived from the Outline)
          │   + code checks the script format (speaker prefixes, length, readable aloud)
          ▼
   ⑤ REVIEW ── Reviewer Agent (separate prompt, separate context)
          │   Input: the text + Fact Sheet; checks every score, number, quote and source attribution line by line
          │   → structured feedback; blocking issues → back to ④ for revision (at most 2 rounds)
          │   Still failing → NEEDS_REVIEW, notify, stop
          ▼
   ⑥ PRODUCE ── Code only: TTS (ElevenLabs, limited concurrency) → audio QA → stitching → upload
          ▼
   ⑦ PUBLISH ── Code only: all outputs present and approved → episodes.status = published
          ▼
     Notify (success / NO_SHOW / failure / needs review)
```

## Step details

### ① DISCOVER: keep facts and opinions apart

The research output has two parts; downstream checks rely on that split:

```jsonc
{
  "matches": [            // only from the ATP data API, the single source of facts
    { "id": "m1", "tournament": "...", "round": "...", "surface": "...",
      "winner": {...}, "loser": {...}, "score": "...", "stats": {...} | null }
  ],
  "articles": [           // from web search, counted as "opinion"
    { "id": "a1", "url": "...", "source": "The Athletic", "published_at": "...",
      "match_ids": ["m1"], "key_points": ["..."], "notable_quote": "..." | null }
  ]
}
```

- Match results are fetched from the API by code; the agent only "picks the highlights + finds commentary".
- Articles are stored as key points and source only, never full text. Quotes are kept only if they really appear in the article, with attribution.
- Missing data is `null` (unknown), never 0. API errors must be reported, never swallowed.
- **Data source: tennis-api.com** (RapidAPI, free tier 50 requests/day). Tested 2026-10-27:
  - `/atp/results/{date}` + `filter=PlayerGroup:singles;TourRank:2,3,4,5,7` returns every main-tour singles match of the day in one request (ITF and Challenger excluded, Davis Cup kept), with surface and pre-match odds.
  - `/matches/{liveMatchId}/stats` is one request per match, with aces, double faults, first serve, second serve, break points and total points won; winners, unforced errors and serve speed are `null`. Break point data was consistent with the score for all 13 matches.
  - The `matchId` in results gets renumbered about a day later, so storage always uses `liveMatchId` (`player1Id-player2Id-tournamentId-roundId`). Player IDs are tennis-api's own, not official ATP IDs, so names are stored alongside them.
  - Times are UTC; `best_of` is `null` and must be inferred from the event level.
- Stats are fetched only for the matches the Research Agent selects, to keep daily request counts down; during development the raw JSON is cached locally so nothing is requested twice.

### ② VALIDATE: block the "impossible", flag the "rare"

Rare is not wrong. In 2026 Basel R1 Shelton hit 44 aces (tied third-most in a single ATP match since 1991). It looks like a data error, but it was the best story of the day. So validation has two classes, handled differently:

| Class | Examples | Handling |
|------|------|------|
| **Impossible** (data contradicts itself) | aces > total service points; one side's break points converted ≠ the other side's break points faced − saved; illegal set score; winner doesn't match the score; negative numbers; date outside the window | Blocked by code, kept out of the Fact Sheet, logged and reported |
| **Rare** (valid but extreme) | aces ≥ 30; double faults ≥ 12; comeback after losing a set 0-6; three straight tie-break sets; the long-odds player wins | Not blocked; flagged `outlier` and sent for verification |

```jsonc
{ "id": "m4.p1.aces", "match_id": "m4", "fact": "Shelton aces = 44",
  "flag": "outlier", "reason": "aces ≥ 30, close to the ATP single-match record",
  "status": "verified" | "unverified",
  "evidence": [{ "url": "https://www.atptour.com/...", "source": "ATP Tour" }] }
```

- **Verification**: the Research Agent runs one targeted search per `outlier`. A reliable source found → `verified` with a link; none found → `unverified`. Ordinary facts that aren't outliers aren't verified.
- **Editor**: outliers are storyline signals; verified outliers get priority.
- **Writer**: `verified` facts can be a focus and can use background from the source (e.g. "tied third-most on record"). `unverified` facts are either left out or hedged ("the data shows…"), never with claims like "record-breaking" that need extra evidence.
- **Reviewer**: checks that no `unverified` fact is stated as a firm conclusion.
- Thresholds start as educated guesses kept in config, and get calibrated against accumulated history later.

### ④⑤ WRITE ⇄ REVIEW: feedback format

Reviewer output:

```jsonc
{
  "pass": false,
  "issues": [
    { "severity": "blocking" | "minor", "line": 12,
      "issue": "Score written as 6-4 7-5, but fact m3 is 6-4 7-6",
      "suggestion": "Change to 6-4 7-6(5)" }
  ]
}
```

- No `blocking` issues means pass; the Writer addresses each issue in its revision.
- Always checked: facts outside the fact sheet, invented quotes, wrong numbers, opinions without a source.
- Reviewer and Writer use different system prompts, different models where useful, and the Reviewer never sees the Writer's reasoning.
- Formatting is checked by code; the Reviewer looks only at content.

### ⑥ PRODUCE: audio QA

1. TTS line by line (limited concurrency, retries on failure). Player names go through a **pronunciation dictionary** (ElevenLabs pronunciation dictionary) to prevent mispronunciations upstream.
2. **QA**: speech-to-text turns each line's audio back into text and compares it with the script → finds skipped or misread lines; code checks duration, silences and loudness.
3. Only failing lines are regenerated (at most N times); still failing → NEEDS_REVIEW.
4. Stitch with a proper tool (e.g. ffmpeg), read the real duration, then upload to Storage.

### No guest role

ALEX / SAM are already a dialogue. Outside perspectives come from the commentary pulled in at ①, cited by the hosts ("according to The Athletic's analysis…"), which is more credible and cheaper than having a model play an expert.

## Roles

| Role | Type | Input | Output | Key constraints |
|------|------|------|------|----------|
| Orchestrator | Code | run_id | Advances the state machine | Every step idempotent; records tokens, cost, duration |
| Research Agent | Agent + tools | Date window | matches + articles | Discovers ongoing events dynamically; facts only from the API |
| Validator | Code + Research Agent (verification) | Research output | Fact Sheet | Blocks impossible data; flags rare data as outliers and verifies it, doesn't block |
| Editor | Agent | Fact Sheet | Outline | Only selects and orders, writes no copy |
| Writers | Agent | Outline + relevant facts | recap / script / metadata | No invented quotes; no data, no talk about data |
| Reviewer | Agent | Text + Fact Sheet | Structured feedback | Separate prompt, separate context |
| Producer | Code | Approved script | MP3 + real duration | Audio QA; script hash bound to the audio |
| Publisher | Code | All outputs | published | Publishes only when everything is green |

## Data model (new / changed)

```sql
runs        (id, target_date, status, started_at, finished_at, error, cost_usd)
            -- status: running | no_show | needs_review | failed | published
run_steps   (id, run_id, step, status, attempt, input_hash, output jsonb,
             tokens_in, tokens_out, duration_ms, error)
fact_sheets (run_id, facts jsonb, articles jsonb, source_meta jsonb)
episodes    + status, run_id, script_hash, audio_script_hash
```

- `script_hash ≠ audio_script_hash` → the audio is stale and must be regenerated.
- Each step's output is stored separately, so a rerun executes only the failed step.

## Runtime

Vercel functions run for at most 300s; the whole chain (many LLM calls + review loop + TTS + QA) would likely time out.

- **Recommended: each step is its own function invocation.** The cron only creates the run and triggers the first step; each step triggers the next when done (or a cron every 5 minutes advances every unfinished run). All state lives in Supabase, so it's naturally recoverable.
- Alternative: run it in GitHub Actions / a long-running worker with the Claude Agent SDK. More flexible, but one more deployment to maintain.

## Frontend

- The home page reads only episodes with `status = published`, and shows the date the episode really covers.
- With no episode, show "Latest episode: October 26" or "No matches today", never fall back to fake data.
- Match pages read only the pre-generated recap.

## Security and configuration

- Endpoints that trigger the pipeline by hand all authenticate with `CRON_SECRET`.
- Model IDs live in config, chosen per role (strong models for Editor / Reviewer, a cheap one for Meta Writer).
- All API keys are used server-side only.

## Open questions

1. ~~**Data source.**~~ Settled (tested 2026-10-27): tennis-api.com returns every main-tour result by date and provides stats for finished matches, so no need to switch. Details under ① DISCOVER. Still to check: the response format on Masters / Grand Slam days (TourRank 3, 4) and Davis Cup (5).
2. **Search tool.** Anthropic's built-in web search tool, or a third party such as Tavily / Brave.
3. **Human review channel.** Notify `NEEDS_REVIEW` by email / Slack / a simple review page.
4. **Show scope.** ATP singles only, or several events in the same week.

## Implementation order

1. **Validate the data source + pick a search tool** → Research tool layer + Validator + Fact Sheet (the foundation).
2. State machine skeleton: `runs` / `run_steps` tables + Orchestrator, each step stubbed out first.
3. Editor → Writers → Reviewer, and the review loop.
4. Producer (TTS + audio QA) + Publisher + notifications.
5. Frontend reads the `published` status.
6. Evaluation: replay past episodes' real data, measure the Reviewer's block rate, the audio QA redo rate, and cost.
