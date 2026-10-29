"""Component-level eval of the script: do the hosts analyse and take positions,
or only read out facts and other people's views?

A judge model labels every script line by what it does (fact, attributed,
analysis, take, other) and checks analysis and takes against the Fact Sheet
(grounded or not). Per outline segment it names the line stating the segment's
point of view, if any, and a line where one host pushes back on the other.

Scores:
- analysis_share: analysis + take lines / content lines (all but `other`).
- take_share: take lines / content lines.
- segments_with_thesis, segments_with_pushback: share of outline segments.
- ungrounded: number of analysis or take lines resting on facts the sheet
  doesn't support. A guard: more analysis is only better if this stays low.

The draft is graded twice when it can be: as WRITE produced it and after
REVIEW's revisions, to see how much analysis the review loop removes.
"""

import json
from typing import Literal

from pydantic import BaseModel

from .. import agent, config, factsheet
from ..schemas import FactSheet, Outline, ScriptLine, StepUsage
from ..steps.write import render_script

KINDS = ("fact", "attributed", "analysis", "take", "other")
METRICS = ("analysis_share", "take_share", "segments_with_thesis", "segments_with_pushback", "ungrounded")


class LineLabel(BaseModel):
    line: int  # 1-based, as in the numbered script
    kind: Literal["fact", "attributed", "analysis", "take", "other"]
    grounded: bool | None  # only for analysis and take


class SegmentGrade(BaseModel):
    segment: int
    thesis_line: int | None
    pushback_line: int | None


class _GradesAnswer(BaseModel):
    lines: list[LineLabel]
    segments: list[SegmentGrade]


SUBMIT_GRADES = agent.submit_tool(
    "submit_grades", "Hand in one label per script line and one grade per segment. Call exactly once.", _GradesAnswer)


class LabeledLine(LineLabel):
    speaker: str
    segment: int | None
    text: str


class ScriptEval(BaseModel):
    run: str
    stage: str  # "write" or "review"
    judge: str
    lines: list[LabeledLine]
    segments: list[SegmentGrade]
    scores: dict[str, float]
    usage: StepUsage


def run(run_name: str, stage: str, script: list[ScriptLine], outline: Outline, sheet: FactSheet,
        open_session=None) -> ScriptEval:
    usage = StepUsage()
    n_lines, n_segs = len(script), len(outline.segments)
    segments = [seg.model_dump(include={"title", "angle", "match_ids"}) for seg in outline.segments]
    tagged = "\n".join(
        f"{i} [segment {'-' if line.segment is None else line.segment}] {line.speaker}: {line.text}"
        for i, line in enumerate(script, 1)
    )
    task = (
        "Outline segments (index = position in this list):\n" + json.dumps(segments, ensure_ascii=False, indent=1)
        + f"\n\nFact Sheet:\n{factsheet.render(sheet)}"
        + f"\n\nScript ({n_lines} lines):\n{tagged}"
    )

    def check(answer: _GradesAnswer) -> str | None:
        problems = []
        got = [x.line for x in answer.lines]
        problems += [f"line {i} has no label" for i in range(1, n_lines + 1) if i not in got]
        problems += [f"line {i}: unknown or labelled twice" for k, i in enumerate(got)
                     if not 1 <= i <= n_lines or i in got[:k]]
        for x in answer.lines:
            if x.kind in ("analysis", "take") and x.grounded is None:
                problems.append(f"line {x.line}: {x.kind} needs grounded true or false")
        got = [s.segment for s in answer.segments]
        problems += [f"segment {i} has no grade" for i in range(n_segs) if i not in got]
        problems += [f"segment {i}: unknown or graded twice" for k, i in enumerate(got)
                     if not 0 <= i < n_segs or i in got[:k]]
        for s in answer.segments:
            for field in ("thesis_line", "pushback_line"):
                i = getattr(s, field)
                if i is not None and not (1 <= i <= n_lines and script[i - 1].segment == s.segment):
                    problems.append(f"segment {s.segment} {field}: line {i} is not tagged with this segment")
        return "\n".join(problems) or None

    answer = agent.run_agent(
        model=config.EVAL_MODEL,
        system=(config.PROMPTS_DIR / "eval_script.md").read_text(),
        task=task,
        submit=SUBMIT_GRADES,
        answer=_GradesAnswer,
        usage=usage,
        check=check,
        open_session=open_session,
    )

    labels = {x.line: x for x in answer.lines}
    lines = [
        LabeledLine(**labels[i].model_dump(), speaker=line.speaker, segment=line.segment, text=line.text)
        for i, line in enumerate(script, 1)
    ]
    grades = sorted(answer.segments, key=lambda s: s.segment)
    content = [x for x in lines if x.kind != "other"]
    share = lambda kinds: sum(x.kind in kinds for x in content) / len(content) if content else 0.0
    scores = {
        "analysis_share": share(("analysis", "take")),
        "take_share": share(("take",)),
        "segments_with_thesis": sum(s.thesis_line is not None for s in grades) / n_segs if n_segs else 0.0,
        "segments_with_pushback": sum(s.pushback_line is not None for s in grades) / n_segs if n_segs else 0.0,
        "ungrounded": float(sum(x.grounded is False for x in lines)),
    }
    return ScriptEval(run=run_name, stage=stage, judge=config.EVAL_MODEL, lines=lines, segments=grades,
                      scores=scores, usage=usage)
