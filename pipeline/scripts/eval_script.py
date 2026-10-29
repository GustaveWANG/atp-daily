"""Grade saved scripts on analysis and point of view (see atp_pipeline/evals/script.py).

Usage:
    uv run python scripts/eval_script.py                 # every run in data/runs/
    uv run python scripts/eval_script.py 2026-10-27 2026-10-27-v1

Grades the draft in data/runs/<run>/write.json (before review) and in
review.json (after), whichever exist, and writes data/runs/<run>/eval_script.json.
"""

import argparse
import sys

from pydantic import BaseModel

from atp_pipeline import config
from atp_pipeline.evals import script as script_eval
from atp_pipeline.schemas import Draft, FactSheet, Outline, ReviewOutput


class SavedEval(BaseModel):
    stages: list[script_eval.ScriptEval]


def fmt(metric: str, value: float) -> str:
    return f"{value:g}" if metric == "ungrounded" else f"{value:.0%}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="*", help="run folders under data/runs/ (default: all with a write.json)")
    args = parser.parse_args()
    runs = args.runs or sorted(d.name for d in config.RUNS_DIR.iterdir() if (d / "write.json").exists())

    totals = {stage: {m: [] for m in script_eval.METRICS} for stage in ("write", "review")}
    for name in runs:
        d = config.RUNS_DIR / name
        for step in ("validate", "plan", "write"):
            if not (d / f"{step}.json").exists():
                sys.exit(f"{d / step}.json not found")
        sheet = FactSheet.model_validate_json((d / "validate.json").read_text())
        outline = Outline.model_validate_json((d / "plan.json").read_text())
        drafts = {"write": Draft.model_validate_json((d / "write.json").read_text())}
        if (d / "review.json").exists():
            drafts["review"] = ReviewOutput.model_validate_json((d / "review.json").read_text()).draft

        results = []
        for stage, draft in drafts.items():
            result = script_eval.run(name, stage, draft.script, outline, sheet)
            results.append(result)
            print(f"{name} [{stage}]: {len(result.lines)} lines, judge {result.judge}")
            counts = {k: sum(x.kind == k for x in result.lines) for k in script_eval.KINDS}
            print("  " + " | ".join(f"{k} {v}" for k, v in counts.items()))
            for x in result.lines:
                if x.kind in ("analysis", "take"):
                    flag = "" if x.grounded else "  [UNGROUNDED]"
                    print(f"    {x.line:>2} {x.kind:<8} {x.speaker}: {x.text}{flag}")
            for s in result.segments:
                print(f"  segment {s.segment} {outline.segments[s.segment].title!r}: "
                      f"thesis {s.thesis_line or '-'}, pushback {s.pushback_line or '-'}")
            print("  " + " | ".join(f"{m} {fmt(m, v)}" for m, v in result.scores.items()))
            for w in result.usage.warnings:
                print(f"  warning: {w}")
            for m, v in result.scores.items():
                totals[stage][m].append(v)

        out = d / "eval_script.json"
        out.write_text(SavedEval(stages=results).model_dump_json(indent=2))
        print(f"saved {out}\n")

    if len(runs) > 1:
        for stage, metrics in totals.items():
            if metrics["analysis_share"]:
                print(f"all runs [{stage}]: " + " | ".join(
                    f"{m} {fmt(m, sum(v) / len(v))}" for m, v in metrics.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
