"""Grade saved DISCOVER outputs on player context (see atp_pipeline/evals/discover.py).

Usage:
    uv run python scripts/eval_discover.py                 # every run in data/runs/
    uv run python scripts/eval_discover.py 2026-10-27 2026-10-27-v1

Reads data/runs/<run>/discover.json and writes data/runs/<run>/eval_discover.json.
"""

import argparse
import sys

from atp_pipeline import config
from atp_pipeline.evals import discover as discover_eval
from atp_pipeline.schemas import DiscoverOutput


def mark(has: bool) -> str:
    return "Y" if has else "-"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="*", help="run folders under data/runs/ (default: all with a discover.json)")
    args = parser.parse_args()
    runs = args.runs or sorted(d.name for d in config.RUNS_DIR.iterdir() if (d / "discover.json").exists())

    totals = {metric: [] for metric in discover_eval.METRICS}
    for name in runs:
        f = config.RUNS_DIR / name / "discover.json"
        if not f.exists():
            sys.exit(f"{f} not found")
        result = discover_eval.run(name, DiscoverOutput.model_validate_json(f.read_text()))

        print(f"{name}: {len(result.players)} players, judge {result.judge}")
        print(f"  {'player':<26} results  news  career")
        for p in result.players:
            print(f"  {p.name:<26} {mark(p.recent_results.has):^7}  {mark(p.recent_news.has):^4}  "
                  f"{mark(p.career_history.has):^6}")
            for metric in discover_eval.METRICS:
                grade = getattr(p, metric)
                if grade.has:
                    print(f"      {metric}: {grade.evidence!r}")
        print("  " + " | ".join(f"{m} {s:.0%}" for m, s in result.scores.items()))
        for w in result.usage.warnings:
            print(f"  warning: {w}")

        out = f.with_name("eval_discover.json")
        out.write_text(result.model_dump_json(indent=2))
        print(f"saved {out}\n")
        for metric in discover_eval.METRICS:
            totals[metric] += [getattr(p, metric).has for p in result.players]

    if len(runs) > 1:
        print("all runs: " + " | ".join(
            f"{m} {sum(v) / len(v):.0%} ({sum(v)}/{len(v)})" for m, v in totals.items() if v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
