"""Step 3 - PLAN.

The editor agent picks 2-4 storylines from the Fact Sheet and returns an
outline: segments with the match, article and outlier ids each one draws on.
Code checks that every id it cites exists, and sends it back to fix them if not.
"""

from pydantic import BaseModel

from .. import agent, config, factsheet
from ..schemas import FactSheet, Outline, Segment, StepUsage


class _OutlineAnswer(BaseModel):
    episode_angle: str
    segments: list[Segment]
    quick_hits: list[str]


SUBMIT_OUTLINE = agent.submit_tool("submit_outline", "Hand in the episode outline. Call exactly once.", _OutlineAnswer)


class PlanError(RuntimeError):
    pass


def run(sheet: FactSheet, open_session=None) -> Outline:
    if sheet.no_show:
        raise PlanError("no matches in the Fact Sheet; nothing to plan")
    usage = StepUsage()
    match_ids = {m.id for m in sheet.matches}
    article_ids = {a.id for a in sheet.articles}
    outlier_ids = {o.id for o in sheet.outliers}

    def check(answer: _OutlineAnswer) -> str | None:
        problems = []
        if not 1 <= len(answer.segments) <= 4:
            problems.append(f"{len(answer.segments)} segments; use 2-4 (1 only on a very thin day)")
        in_segments = set()
        for i, seg in enumerate(answer.segments):
            if not seg.match_ids:
                problems.append(f"segment {i} has no match_ids")
            if not seg.take.strip():
                problems.append(f"segment {i} has no take")
            for kind, ids, known in (("match", seg.match_ids, match_ids), ("article", seg.article_ids, article_ids),
                                     ("outlier", seg.outlier_ids, outlier_ids)):
                problems += [f"segment {i}: unknown {kind} id {x!r}" for x in ids if x not in known]
            in_segments.update(seg.match_ids)
        problems += [f"quick_hits: unknown match id {x!r}" for x in answer.quick_hits if x not in match_ids]
        problems += [f"quick_hits: {x!r} is already in a segment" for x in answer.quick_hits if x in in_segments]
        return "\n".join(problems) or None

    answer = agent.run_agent(
        model=config.EDITOR_MODEL,
        system=(config.PROMPTS_DIR / "editor.md").read_text(),
        task=f"Fact Sheet for {sheet.target_date}:\n\n{factsheet.render(sheet)}",
        submit=SUBMIT_OUTLINE,
        answer=_OutlineAnswer,
        usage=usage,
        check=check,
        open_session=open_session,
    )
    return Outline(target_date=sheet.target_date, usage=usage, **answer.model_dump())
