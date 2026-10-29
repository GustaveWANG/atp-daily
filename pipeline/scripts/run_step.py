"""Run pipeline steps locally and save each one's output.

Usage:
    uv run python scripts/run_step.py discover [--date YYYY-MM-DD]
    uv run python scripts/run_step.py validate plan write review --date 2026-10-27
    uv run python scripts/run_step.py produce --date 2026-10-27   # audio, needs ffmpeg

--date defaults to yesterday (UTC). Each step reads the earlier steps' output
from data/runs/<date>/ and writes its own to data/runs/<date>/<step>.json, so
any step can be rerun on its own. --run <name> uses data/runs/<name>/ instead.
"""

import argparse
import sys
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel

from atp_pipeline import config
from atp_pipeline.schemas import DiscoverOutput, Draft, FactSheet, Outline, ReviewOutput, StepUsage
from atp_pipeline.steps import discover, plan, produce, review, validate, write

STEPS = ["discover", "validate", "plan", "write", "review", "produce"]


class Run:
    def __init__(self, day: str, name: str | None = None):
        self.day = day
        self.dir = config.RUNS_DIR / (name or day)

    def load(self, step: str, model: type[BaseModel]):
        f = self.dir / f"{step}.json"
        if not f.exists():
            sys.exit(f"{f} not found; run the {step} step first")
        return model.model_validate_json(f.read_text())

    def save(self, step: str, output: BaseModel) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        f = self.dir / f"{step}.json"
        f.write_text(output.model_dump_json(indent=2))
        print(f"saved {f}\n")


def run_discover(run: Run) -> None:
    output = discover.run(run.day)
    meta = output.source_meta
    selected = [m for m in output.matches if m.selected]
    print(f"{run.day}: {len(output.matches)} matches, {len(selected)} selected, {len(output.articles)} articles")
    for m in selected:
        print(f"  * {m.winner.name} d. {m.loser.name} {m.score} - {m.selection_reason}")
    for a in output.articles:
        print(f"  [{a.id}] {a.source}: {a.title or a.url} -> {', '.join(a.match_ids)}")
    print(
        f"tennis-api: {meta.tennis_api_requests} requests, {meta.tennis_api_cache_hits} cache hits | "
        f"tavily: {meta.web_searches} searches, {meta.web_fetches} fetches, "
        f"{meta.tavily_requests} requests, {meta.tavily_credits:g} credits | "
        f"model: {meta.input_tokens} in / {meta.output_tokens} out tokens"
    )
    for w in meta.warnings:
        print(f"  warning: {w}")
    run.save("discover", output)


def run_validate(run: Run) -> None:
    sheet = validate.run(run.load("discover", DiscoverOutput))
    print(f"validate: {len(sheet.matches)} matches kept, {len(sheet.rejected)} rejections"
          f"{' -> NO_SHOW' if sheet.no_show else ''}")
    for r in sheet.rejected:
        print(f"  rejected ({r.scope}) {r.match_id}: {r.reason}")
    for o in sheet.outliers:
        print(f"  outlier [{o.status}] {o.fact}" + (f" - {o.context}" if o.context else ""))
        for ev in o.evidence:
            print(f"      {ev.source}: {ev.excerpt[:100]!r}")
    _print_usage(sheet.usage)
    run.save("validate", sheet)


def run_plan(run: Run) -> None:
    sheet = run.load("validate", FactSheet)
    if sheet.no_show:
        print("plan: NO_SHOW, nothing to plan")
        return
    outline = plan.run(sheet)
    print(f"plan: {outline.episode_angle}")
    for i, seg in enumerate(outline.segments):
        print(f"  {i}. {seg.title} - {seg.angle}")
        print(f"     take: {seg.take}")
        print(f"     matches {len(seg.match_ids)}, articles {seg.article_ids}, outliers {len(seg.outlier_ids)}")
    print(f"  quick hits: {len(outline.quick_hits)} matches")
    _print_usage(outline.usage)
    run.save("plan", outline)


def run_write(run: Run) -> None:
    draft = write.run(run.load("validate", FactSheet), run.load("plan", Outline))
    _print_draft(draft)
    run.save("write", draft)


def run_review(run: Run) -> None:
    result = review.run(run.load("validate", FactSheet), run.load("plan", Outline), run.load("write", Draft))
    for r in result.rounds:
        blocking = [i for i in r.issues if i.severity == "blocking"]
        print(f"review round {r.round}: {'PASS' if r.passed else 'FAIL'} "
              f"({len(blocking)} blocking, {len(r.issues) - len(blocking)} minor)")
        for i in r.issues:
            where = f"{i.target}{f' line {i.line}' if i.line else ''}"
            print(f"  [{i.severity}] {where}: {i.issue}")
    print(f"status: {result.status.upper()}")
    _print_usage(result.usage)
    run.save("review", result)


def run_produce(run: Run) -> None:
    result = run.load("review", ReviewOutput)
    if result.status != "passed":
        print("produce: the script has not passed review, no audio made")
        return
    output = produce.run(result, run.dir / "audio")
    failed = [line for line in output.lines if line.issues]
    rerolled = sum(1 for line in output.lines if line.attempts > 1)
    print(f"produce: {len(output.lines)} lines, {output.duration / 60:.1f} min, "
          f"{rerolled} re-rolled, {len(failed)} still failing QA -> {output.status.upper()}")
    for line in failed:
        print(f"  line {line.index} {line.speaker}: {'; '.join(line.issues)}")
        print(f"      heard: {line.transcript[:120]!r}")
    u = output.usage
    print(f"  elevenlabs: {u.tts_requests} TTS requests / {u.tts_characters} characters, "
          f"{u.stt_requests} STT requests / {u.stt_seconds:g}s, {u.cache_hits} cache hits")
    print(f"  audio: {run.dir / output.audio_file}")
    run.save("produce", output)


def _print_draft(draft: Draft) -> None:
    words = sum(len(line.text.split()) for line in draft.script)
    print(f"write: script {len(draft.script)} lines / {words} words")
    print(f"  dialogue: {write.dialogue_stats(draft.script)}")
    print(f"  title: {draft.meta.title}\n  headline: {draft.meta.headline}")
    for i in draft.format_issues:
        print(f"  format: {i.target}{f' line {i.line}' if i.line else ''}: {i.issue}")
    _print_usage(draft.usage)


def _print_usage(u: StepUsage) -> None:
    web = f", {u.web_searches} searches, {u.web_fetches} fetches" if u.web_searches or u.web_fetches else ""
    print(f"  model: {u.calls} calls, {u.input_tokens} in / {u.output_tokens} out tokens{web}")
    for w in u.warnings:
        print(f"  warning: {w}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("steps", nargs="+", choices=STEPS)
    parser.add_argument("--date", default=(datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat())
    parser.add_argument("--run", help="run folder under data/runs/ (default: the date), to keep experiments apart")
    args = parser.parse_args()

    run = Run(args.date, args.run)
    for step in sorted(set(args.steps), key=STEPS.index):
        globals()[f"run_{step}"](run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
