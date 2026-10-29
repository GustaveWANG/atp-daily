"""Component-level eval of DISCOVER: does the research give the hosts anything
about the players beyond yesterday's scoreline?

For every player in a selected match, a judge model answers three yes/no
questions from the articles DISCOVER handed in (key points and quotes, which is
all that reaches the later steps):

- recent_results: recent form in numbers (streaks, season record, ranking).
- recent_news: recent news beyond the numbers (injury, coach, changes, off-court).
- career_history: the player's past since turning pro (titles, records, history).

recent_results and recent_news split "recent form": a sheet can be full of
season records and still say nothing a fan would call news.

Each "yes" must quote its evidence from the material; code checks the quote is
there, so the judge can't answer from its own knowledge.
"""

import json

from pydantic import BaseModel

from .. import agent, config
from ..schemas import DiscoverOutput, StepUsage

METRICS = ("recent_results", "recent_news", "career_history")


class Grade(BaseModel):
    has: bool
    evidence: str | None  # copied from the material; None when has is False


class PlayerGrade(BaseModel):
    player_id: str  # "<match_id>.winner" or "<match_id>.loser"
    recent_results: Grade
    recent_news: Grade
    career_history: Grade


class _GradesAnswer(BaseModel):
    grades: list[PlayerGrade]


SUBMIT_GRADES = agent.submit_tool("submit_grades", "Hand in one grade per player. Call exactly once.", _GradesAnswer)


class PlayerResult(PlayerGrade):
    name: str
    match_id: str


class DiscoverEval(BaseModel):
    run: str
    judge: str
    players: list[PlayerResult]
    scores: dict[str, float]  # metric -> share of players with a "yes"
    usage: StepUsage


def run(run_name: str, output: DiscoverOutput, open_session=None) -> DiscoverEval:
    usage = StepUsage()
    players = {}
    for m in output.matches:
        if m.selected:
            players[f"{m.id}.winner"] = (m.winner.name, m.id)
            players[f"{m.id}.loser"] = (m.loser.name, m.id)
    if not players:
        return DiscoverEval(run=run_name, judge=config.EVAL_MODEL, players=[], scores={}, usage=usage)

    articles = [
        a.model_dump(include={"id", "source", "title", "match_ids", "key_points", "notable_quote"})
        for a in output.articles
    ]
    material = "\n".join(
        part for a in articles for part in [a["title"] or "", *a["key_points"], a["notable_quote"] or ""]
    )
    matches = [
        {"match_id": m.id, "tournament": m.tournament, "round": m.round,
         "winner": m.winner.name, "loser": m.loser.name, "score": m.score}
        for m in output.matches if m.selected
    ]
    task = (
        "Players to grade:\n"
        + json.dumps([{"player_id": pid, "name": name} for pid, (name, _) in players.items()], ensure_ascii=False, indent=1)
        + "\n\nTheir matches yesterday:\n" + json.dumps(matches, ensure_ascii=False, indent=1)
        + "\n\nResearch material:\n" + json.dumps(articles, ensure_ascii=False, indent=1)
    )

    def check(answer: _GradesAnswer) -> str | None:
        problems = []
        got = [g.player_id for g in answer.grades]
        problems += [f"missing player {pid!r}" for pid in players if pid not in got]
        problems += [f"unknown or repeated player {pid!r}" for i, pid in enumerate(got)
                     if pid not in players or pid in got[:i]]
        for g in answer.grades:
            for metric in METRICS:
                grade: Grade = getattr(g, metric)
                if grade.has and not (grade.evidence and agent.appears_in(grade.evidence, material)):
                    problems.append(f"{g.player_id} {metric}: evidence is not copied word for word from the material")
        return "\n".join(problems) or None

    answer = agent.run_agent(
        model=config.EVAL_MODEL,
        system=(config.PROMPTS_DIR / "eval_discover.md").read_text(),
        task=task,
        submit=SUBMIT_GRADES,
        answer=_GradesAnswer,
        usage=usage,
        check=check,
        open_session=open_session,
    )

    results = [
        PlayerResult(name=players[g.player_id][0], match_id=players[g.player_id][1], **g.model_dump())
        for g in sorted(answer.grades, key=lambda g: list(players).index(g.player_id))
    ]
    scores = {metric: sum(getattr(r, metric).has for r in results) / len(results) for metric in METRICS}
    return DiscoverEval(run=run_name, judge=config.EVAL_MODEL, players=results, scores=scores, usage=usage)
