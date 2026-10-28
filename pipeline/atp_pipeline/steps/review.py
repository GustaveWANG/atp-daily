"""Step 5 - REVIEW.

An independent reviewer agent (its own prompt and, by default, a different
vendor than the writers) checks the draft against the Fact Sheet and returns
structured issues. Together with the code's format issues, any blocking issue
sends the flagged parts back to the writers (write.revise). After
MAX_REVISIONS rewrites that still don't pass, the run stops as needs_review.
"""

from pydantic import BaseModel

from .. import agent, config, factsheet
from ..schemas import Draft, FactSheet, Outline, ReviewIssue, ReviewOutput, ReviewRound, StepUsage
from . import write


class _ReviewAnswer(BaseModel):
    issues: list[ReviewIssue]


SUBMIT_REVIEW = agent.submit_tool("submit_review", "Hand in every issue found (or none). Call exactly once.", _ReviewAnswer)


def run(sheet: FactSheet, outline: Outline, draft: Draft) -> ReviewOutput:
    usage = StepUsage()
    rounds: list[ReviewRound] = []
    for n in range(1, config.MAX_REVISIONS + 2):
        issues = draft.format_issues + review(sheet, outline, draft, usage)
        passed = not any(i.severity == "blocking" for i in issues)
        rounds.append(ReviewRound(round=n, passed=passed, issues=issues))
        if passed or n > config.MAX_REVISIONS:
            break
        draft = write.revise(sheet, outline, draft, issues)
    return ReviewOutput(
        target_date=sheet.target_date,
        status="passed" if rounds[-1].passed else "needs_review",
        rounds=rounds,
        draft=draft,
        usage=usage,
    )


def review(sheet: FactSheet, outline: Outline, draft: Draft, usage: StepUsage) -> list[ReviewIssue]:
    recap_targets = {f"recap:{r.match_id}" for r in draft.recaps}
    targets = {"script", "meta"} | recap_targets

    def check(answer: _ReviewAnswer) -> str | None:
        problems = []
        for i, issue in enumerate(answer.issues):
            if issue.target not in targets:
                problems.append(f"issue {i}: target must be one of {sorted(targets)}")
            elif issue.target == "script" and issue.line is not None and not 1 <= issue.line <= len(draft.script):
                problems.append(f"issue {i}: script has lines 1-{len(draft.script)}")
        return "\n".join(problems) or None

    recaps = "\n\n".join(f"### recap:{r.match_id}\n\n{r.text}" for r in draft.recaps)
    task = (
        f"# Fact Sheet\n\n{factsheet.render(sheet, write.covered_match_ids(outline))}\n\n"
        f"# Draft\n\n## script\n\n{write.render_script(draft.script)}\n\n"
        f"## recaps\n\n{recaps}\n\n"
        f"## meta\n\n{draft.meta.model_dump_json(indent=1)}"
    )
    answer = agent.run_agent(
        model=config.REVIEWER_MODEL,
        system=(config.PROMPTS_DIR / "reviewer.md").read_text(),
        task=task,
        submit=SUBMIT_REVIEW,
        answer=_ReviewAnswer,
        usage=usage,
        check=check,
    )
    return answer.issues
