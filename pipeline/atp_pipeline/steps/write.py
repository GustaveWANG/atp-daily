"""Step 4 - WRITE.

Three kinds of writer, run in parallel, each seeing only the facts it needs:
- recap writer: one web recap per covered match, from that match's facts alone
- script writer: the ALEX / SAM script, following the outline
- meta writer: title, headline, The Read, Bracket Watch

Code then checks the format (speakers, length, whether it can be read aloud).
revise() reruns only the parts the reviewer (or the format check) flagged,
handing each writer its previous version and the issues to fix.
"""

import re
from concurrent.futures import ThreadPoolExecutor

from pydantic import BaseModel

from .. import agent, config, factsheet
from ..schemas import Draft, EpisodeMeta, FactSheet, Outline, Recap, ReviewIssue, ScriptLine, StepUsage


class _ScriptAnswer(BaseModel):
    lines: list[ScriptLine]


class _RecapAnswer(BaseModel):
    text: str


SUBMIT_SCRIPT = agent.submit_tool("submit_script", "Hand in the full script. Call exactly once.", _ScriptAnswer)
SUBMIT_RECAP = agent.submit_tool("submit_recap", "Hand in the recap. Call exactly once.", _RecapAnswer)
SUBMIT_META = agent.submit_tool("submit_meta", "Hand in the episode metadata. Call exactly once.", EpisodeMeta)


def _prompt(name: str) -> str:
    rules = (config.PROMPTS_DIR / "_rules.md").read_text()
    return (config.PROMPTS_DIR / f"{name}.md").read_text().replace("{rules}", rules)


def covered_match_ids(outline: Outline) -> list[str]:
    ids = [mid for seg in outline.segments for mid in seg.match_ids] + outline.quick_hits
    return list(dict.fromkeys(ids))


def render_script(lines: list[ScriptLine]) -> str:
    """Numbered from 1; the reviewer's line numbers refer to this."""
    return "\n".join(f"{i} {line.speaker}: {line.text}" for i, line in enumerate(lines, 1))


def _revision_note(previous: str, issues: list[ReviewIssue]) -> str:
    listed = "\n".join(
        f"- [{i.severity}]{f' line {i.line}' if i.line else ''}: {i.issue} Suggested fix: {i.suggestion}"
        for i in issues
    )
    return (
        f"\n\n## Revision\n\nYour previous version:\n\n{previous}\n\n"
        f"The fact-checker found these problems. Fix every blocking one, and the minor ones where you can. "
        f"Keep everything else as it was.\n\n{listed}"
    )


# ------------------------------------------------------------------ writers


def write_script(sheet, outline, usage, previous=None, issues=()) -> list[ScriptLine]:
    n = len(outline.segments)
    task = (
        f"Outline:\n\n{outline.model_dump_json(include={'episode_angle', 'segments', 'quick_hits'}, indent=1)}\n\n"
        f"Fact Sheet:\n\n{factsheet.render(sheet, covered_match_ids(outline))}"
    )
    if previous is not None:
        task += _revision_note(render_script(previous), issues)

    def check(answer: _ScriptAnswer) -> str | None:
        bad = [i for i, line in enumerate(answer.lines, 1) if line.segment is not None and not 0 <= line.segment < n]
        return f"lines {bad} have a segment index outside 0..{n - 1}" if bad else None

    answer = agent.run_agent(
        model=config.WRITER_MODEL, system=_prompt("script"), task=task,
        submit=SUBMIT_SCRIPT, answer=_ScriptAnswer, usage=usage, check=check,
    )
    return answer.lines


def write_recap(sheet, match_id, usage, previous=None, issues=()) -> Recap:
    task = f"Fact Sheet for match {match_id}:\n\n{factsheet.render(sheet, [match_id])}"
    if previous is not None:
        task += _revision_note(previous.text, issues)
    answer = agent.run_agent(
        model=config.WRITER_MODEL, system=_prompt("recap"), task=task,
        submit=SUBMIT_RECAP, answer=_RecapAnswer, usage=usage,
    )
    return Recap(match_id=match_id, text=answer.text.strip())


def write_meta(sheet, outline, usage, previous=None, issues=()) -> EpisodeMeta:
    task = (
        f"Outline:\n\n{outline.model_dump_json(include={'episode_angle', 'segments', 'quick_hits'}, indent=1)}\n\n"
        f"Fact Sheet:\n\n{factsheet.render(sheet, covered_match_ids(outline))}"
    )
    if previous is not None:
        task += _revision_note(previous.model_dump_json(indent=1), issues)
    return agent.run_agent(
        model=config.META_MODEL, system=_prompt("meta"), task=task,
        submit=SUBMIT_META, answer=EpisodeMeta, usage=usage,
    )


# ------------------------------------------------------------------- steps


def run(sheet: FactSheet, outline: Outline) -> Draft:
    jobs = {"script": lambda u: write_script(sheet, outline, u), "meta": lambda u: write_meta(sheet, outline, u)}
    for mid in covered_match_ids(outline):
        jobs[f"recap:{mid}"] = lambda u, mid=mid: write_recap(sheet, mid, u)
    results, usage = _run_parallel(jobs)
    return _assemble(sheet, outline, results["script"], [v for k, v in results.items() if k.startswith("recap:")],
                     results["meta"], usage)


def revise(sheet: FactSheet, outline: Outline, draft: Draft, issues: list[ReviewIssue]) -> Draft:
    """Rewrite each part that has a blocking issue; keep the others as they are."""
    by_target: dict[str, list[ReviewIssue]] = {}
    for issue in issues:
        by_target.setdefault(issue.target, []).append(issue)
    to_fix = {t for t, items in by_target.items() if any(i.severity == "blocking" for i in items)}
    recaps = {r.match_id: r for r in draft.recaps}

    jobs = {}
    if "script" in to_fix:
        jobs["script"] = lambda u: write_script(sheet, outline, u, draft.script, by_target["script"])
    if "meta" in to_fix:
        jobs["meta"] = lambda u: write_meta(sheet, outline, u, draft.meta, by_target["meta"])
    for target in to_fix:
        mid = target.removeprefix("recap:")
        if target.startswith("recap:") and mid in recaps:
            jobs[target] = lambda u, mid=mid, t=target: write_recap(sheet, mid, u, recaps[mid], by_target[t])
    results, usage = _run_parallel(jobs)

    for target, value in results.items():
        if target.startswith("recap:"):
            recaps[value.match_id] = value
    usage.add(draft.usage)
    return _assemble(sheet, outline, results.get("script", draft.script), list(recaps.values()),
                     results.get("meta", draft.meta), usage)


def _run_parallel(jobs: dict) -> tuple[dict, StepUsage]:
    """Each job gets its own usage record (no sharing across threads); merged after."""
    usages = {name: StepUsage() for name in jobs}
    with ThreadPoolExecutor(max_workers=config.WRITE_CONCURRENCY) as pool:
        futures = {name: pool.submit(job, usages[name]) for name, job in jobs.items()}
        results = {name: f.result() for name, f in futures.items()}
    total = StepUsage()
    for u in usages.values():
        total.add(u)
    return results, total


def _assemble(sheet, outline, script, recaps, meta, usage) -> Draft:
    order = {mid: i for i, mid in enumerate(covered_match_ids(outline))}
    recaps = sorted(recaps, key=lambda r: order.get(r.match_id, len(order)))
    return Draft(
        target_date=sheet.target_date,
        script=script,
        recaps=recaps,
        meta=meta,
        chapter_titles=[seg.title for seg in outline.segments],
        format_issues=check_format(script, recaps, meta, len(outline.segments)),
        usage=usage,
    )


# ------------------------------------------------------------ format check

UNSPEAKABLE = [
    (re.compile(r"\d+-\d+"), "score written in digits; write it as words"),
    (re.compile(r"[*#_`\[\]{}<>|]"), "markdown or brackets"),
    (re.compile(r"\(|\)"), "parentheses (TTS reads them flatly or skips them)"),
    (re.compile(r"https?://|www\."), "URL"),
    (re.compile(r"[\U0001F300-\U0001FAFF☀-➿]"), "emoji"),
]
MARKDOWN = re.compile(r"^\s*([#*-]|\d+\.)\s|\*\*")


def _blocking(target: str, issue: str, line: int | None = None) -> ReviewIssue:
    return ReviewIssue(severity="blocking", target=target, line=line, issue=issue, suggestion="Fix the format.")


def check_format(script: list[ScriptLine], recaps: list[Recap], meta: EpisodeMeta, n_segments: int) -> list[ReviewIssue]:
    issues = []
    words = 0
    for i, line in enumerate(script, 1):
        text = line.text.strip()
        n = len(text.split())
        words += n
        if not text:
            issues.append(_blocking("script", "empty line", i))
        if n > config.SCRIPT_MAX_LINE_WORDS:
            issues.append(_blocking("script", f"line is {n} words; split it (max {config.SCRIPT_MAX_LINE_WORDS})", i))
        for pattern, what in UNSPEAKABLE:
            if found := pattern.search(text):
                issues.append(_blocking("script", f"not speakable: {what} ({found.group()!r})", i))
    if not config.SCRIPT_MIN_WORDS <= words <= config.SCRIPT_MAX_WORDS:
        issues.append(_blocking("script", f"script is {words} words; aim for "
                                f"{config.SCRIPT_MIN_WORDS}-{config.SCRIPT_MAX_WORDS}"))
    if {line.speaker for line in script} != {"ALEX", "SAM"}:
        issues.append(_blocking("script", "both ALEX and SAM must speak"))
    missing = set(range(n_segments)) - {line.segment for line in script}
    if missing:
        issues.append(_blocking("script", f"outline segments {sorted(missing)} have no lines"))

    for r in recaps:
        n = len(r.text.split())
        if not 80 <= n <= 350:
            issues.append(_blocking(f"recap:{r.match_id}", f"recap is {n} words; aim for 120-250"))
        if any(MARKDOWN.search(p) for p in r.text.splitlines()):
            issues.append(_blocking(f"recap:{r.match_id}", "recap contains markdown; plain text only"))

    if len(meta.title) > 80:
        issues.append(_blocking("meta", f"title is {len(meta.title)} characters (max 70)"))
    if len(meta.headline) > 180:
        issues.append(_blocking("meta", f"headline is {len(meta.headline)} characters (max 160)"))
    return issues
