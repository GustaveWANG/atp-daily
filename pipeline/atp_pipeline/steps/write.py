"""Step 4 - WRITE.

Two writers, run in parallel, each seeing only the facts it needs:
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
from ..schemas import Draft, EpisodeMeta, FactSheet, Outline, ReviewIssue, ScriptLine, StepUsage


class _ScriptAnswer(BaseModel):
    lines: list[ScriptLine]


SUBMIT_SCRIPT = agent.submit_tool("submit_script", "Hand in the full script. Call exactly once.", _ScriptAnswer)
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
    results, usage = _run_parallel(jobs)
    return _assemble(sheet, outline, results["script"], results["meta"], usage)


def revise(sheet: FactSheet, outline: Outline, draft: Draft, issues: list[ReviewIssue]) -> Draft:
    """Rewrite each part that has a blocking issue; keep the others as they are."""
    by_target: dict[str, list[ReviewIssue]] = {}
    for issue in issues:
        by_target.setdefault(issue.target, []).append(issue)
    to_fix = {t for t, items in by_target.items() if any(i.severity == "blocking" for i in items)}

    jobs = {}
    if "script" in to_fix:
        jobs["script"] = lambda u: write_script(sheet, outline, u, draft.script, by_target["script"])
    if "meta" in to_fix:
        jobs["meta"] = lambda u: write_meta(sheet, outline, u, draft.meta, by_target["meta"])
    results, usage = _run_parallel(jobs)

    usage.add(draft.usage)
    return _assemble(sheet, outline, results.get("script", draft.script), results.get("meta", draft.meta), usage)


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


def _assemble(sheet, outline, script, meta, usage) -> Draft:
    return Draft(
        target_date=sheet.target_date,
        script=script,
        meta=meta,
        chapter_titles=[seg.title for seg in outline.segments],
        format_issues=check_format(script, meta, len(outline.segments)),
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


def _blocking(target: str, issue: str, line: int | None = None) -> ReviewIssue:
    return ReviewIssue(severity="blocking", target=target, line=line, issue=issue, suggestion="Fix the format.")


def check_format(script: list[ScriptLine], meta: EpisodeMeta, n_segments: int) -> list[ReviewIssue]:
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
    issues += check_dialogue(script)

    if len(meta.title) > 80:
        issues.append(_blocking("meta", f"title is {len(meta.title)} characters (max 70)"))
    if len(meta.headline) > 180:
        issues.append(_blocking("meta", f"headline is {len(meta.headline)} characters (max 160)"))
    return issues


# ---------------------------------------------------------- dialogue check

# Openers that tack the next fact onto the other host's line instead of
# answering it: the "relay" pattern that makes two hosts sound like one.
RELAY_OPENER = re.compile(r"^(and|plus|also|on top of that|what's more)\b", re.IGNORECASE)


_NUMBER_WORD = (r"(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|"
                r"fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|"
                r"ninety|hundred|thousand|love|\d+(?:\.\d+)?)")
# One spoken number: "forty-four", "a hundred and twenty-one", "six-four", "one-point-one-nine".
SPOKEN_NUMBER = re.compile(rf"\b{_NUMBER_WORD}(?:(?:[- ]|\s+and\s+|\s+a\s+|-point-){_NUMBER_WORD})*\b", re.IGNORECASE)


def count_numbers(text: str) -> int:
    # A lone "one" is usually a pronoun ("the ugly one"), not a stat.
    return sum(m.group(0).lower() != "one" for m in SPOKEN_NUMBER.finditer(text))


def dialogue_stats(script: list[ScriptLine]) -> dict:
    """Cheap signals of back-and-forth. Speaker-based ones skip each host's first line."""
    n = len(script)
    turns = list(zip(script, script[1:]))
    return {
        "lines": n,
        "questions": sum("?" in line.text for line in script),
        "short_lines": sum(len(line.text.split()) <= config.DIALOGUE_SHORT_LINE_WORDS for line in script),
        "same_speaker": sum(a.speaker == b.speaker for a, b in turns),
        "relay_lines": sum(bool(RELAY_OPENER.match(b.text.strip())) for a, b in turns if a.speaker != b.speaker),
        "numbers_per_100_words": round(
            100 * sum(count_numbers(l.text) for l in script) / max(1, sum(len(l.text.split()) for l in script)), 1),
        "percent_mentions": sum(len(re.findall(r"\bpercent\b", l.text, re.IGNORECASE)) for l in script),
        "sam_word_share": round(
            sum(len(l.text.split()) for l in script if l.speaker == "SAM")
            / max(1, sum(len(l.text.split()) for l in script)), 2),
    }


def check_dialogue(script: list[ScriptLine]) -> list[ReviewIssue]:
    s = dialogue_stats(script)
    problems = []
    if s["questions"] < config.DIALOGUE_MIN_QUESTIONS:
        problems.append(f"only {s['questions']} lines ask a question (want {config.DIALOGUE_MIN_QUESTIONS}+); "
                        "the hosts should ask each other real questions, not just take turns stating facts")
    if s["short_lines"] < config.DIALOGUE_MIN_SHORT_LINES:
        problems.append(f"only {s['short_lines']} short reactions of {config.DIALOGUE_SHORT_LINE_WORDS} words or "
                        f"fewer (want {config.DIALOGUE_MIN_SHORT_LINES}+); let a host react before adding facts")
    if s["same_speaker"] > config.DIALOGUE_MAX_SAME_SPEAKER:
        problems.append(f"a host speaks twice in a row {s['same_speaker']} times "
                        f"(max {config.DIALOGUE_MAX_SAME_SPEAKER}); hand over instead")
    if s["relay_lines"] > config.DIALOGUE_MAX_RELAY_SHARE * s["lines"]:
        problems.append(f"{s['relay_lines']} of {s['lines']} lines open with \"And\"/\"Plus\"/\"Also\" and just add "
                        "the next fact; respond to what the other host said first")
    if s["numbers_per_100_words"] > config.NUMBERS_MAX_PER_100_WORDS:
        problems.append(f"{s['numbers_per_100_words']} spoken numbers per 100 words (max "
                        f"{config.NUMBERS_MAX_PER_100_WORDS}); it sounds like a stat sheet. Keep the one stat that "
                        "proves each point, say the rest in words, and spend the lines on how the match was played")
    if s["percent_mentions"] > config.NUMBERS_MAX_PERCENT:
        problems.append(f"{s['percent_mentions']} percentages (max {config.NUMBERS_MAX_PERCENT}); never give a count "
                        "and its percentage, and prefer plain words (\"he barely lost a point on first serve\")")
    return [ReviewIssue(severity=config.DIALOGUE_SEVERITY, target="script", line=None,
                        issue=f"dialogue: {p}", suggestion="Rework the exchange so the hosts talk to each other.")
            for p in problems]
