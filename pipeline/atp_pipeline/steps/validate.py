"""Step 2 - VALIDATE.

Code checks the research output against hard rules. Impossible data (an
illegal score, stats that contradict each other) is kept out of the Fact
Sheet: a bad score drops the match, bad stats drop only the stats. Rare but
valid values are flagged as outliers instead, and a verification agent makes
one targeted web search per outlier to confirm them. Evidence it cites must be
a page it read, with an excerpt that appears on that page.
"""

import re

from pydantic import BaseModel

from .. import agent, config
from ..schemas import DiscoverOutput, Evidence, FactSheet, Match, Outlier, PlayerStats, Rejection, StepUsage
from ..tools.tavily import TavilyClient

SET_RE = re.compile(r"^(\d+)-(\d+)(?:\((\d+)\))?$")


def run(discovered: DiscoverOutput, search: TavilyClient | None = None, open_session=None) -> FactSheet:
    usage = StepUsage(warnings=list(discovered.source_meta.warnings))
    rejected: list[Rejection] = []
    matches: list[Match] = []
    seen: set = set()

    for m in discovered.matches:
        key = (m.tournament_id, frozenset((m.winner.id, m.loser.id)))
        if m.id in seen or key in seen:
            rejected.append(Rejection(match_id=m.id, scope="match", reason="duplicate match"))
            continue
        seen.update((m.id, key))
        problem = check_match(m, discovered.target_date)
        if problem:
            rejected.append(Rejection(match_id=m.id, scope="match", reason=problem))
            continue
        if m.stats is not None:
            problem = check_stats(m)
            if problem:
                rejected.append(Rejection(match_id=m.id, scope="stats", reason=problem))
                m = m.model_copy(update={"stats": None})
        matches.append(m)

    # Articles may only point at matches that made it into the Fact Sheet.
    kept = {m.id for m in matches}
    articles = []
    for a in discovered.articles:
        ids = [i for i in a.match_ids if i in kept]
        if ids:
            articles.append(a.model_copy(update={"match_ids": ids}))
        else:
            usage.warnings.append(f"article {a.id} only covered rejected matches, dropped")

    outliers = [o for m in matches for o in find_outliers(m)]
    if outliers:
        _verify(discovered.target_date, matches, outliers, usage, search, open_session)

    return FactSheet(
        target_date=discovered.target_date,
        no_show=not matches,
        matches=matches,
        articles=articles,
        outliers=outliers,
        rejected=rejected,
        usage=usage,
    )


# ------------------------------------------------------------- hard rules


def parse_score(score: str) -> list[tuple[int, int, int | None]]:
    """'7-6(5) 3-6 6-4' -> [(7, 6, 5), (3, 6, None), (6, 4, None)], winner's games first."""
    sets = []
    for part in score.split():
        m = SET_RE.match(part)
        if not m:
            raise ValueError(f"unreadable set {part!r}")
        sets.append((int(m[1]), int(m[2]), int(m[3]) if m[3] else None))
    return sets


def _legal_set(a: int, b: int, tiebreak: int | None) -> bool:
    hi, lo = max(a, b), min(a, b)
    if (hi, lo) == (7, 6):
        return True
    if tiebreak is not None:
        return False
    return (hi == 6 and lo <= 4) or (hi, lo) == (7, 5)


def check_match(m: Match, day: str) -> str | None:
    """Reason the match can't be used, or None."""
    if not m.date.startswith(day):
        return f"date {m.date} is outside {day}"
    if m.winner.id == m.loser.id:
        return "winner and loser are the same player"
    if m.result_type == "walkover":
        return None
    try:
        sets = parse_score(m.score)
    except ValueError as e:
        return f"score {m.score!r}: {e}"
    if not sets:
        return "empty score"

    to_win = 3 if m.level == "grand_slam" else 2
    won = lost = 0
    for i, (a, b, tb) in enumerate(sets):
        last = i == len(sets) - 1
        if won == to_win or lost == to_win:
            return f"score {m.score!r} goes on after the match was decided"
        if _legal_set(a, b, tb):
            won, lost = won + (a > b), lost + (b > a)
        elif not (last and m.result_type != "completed" and a <= 7 and b <= 7):
            # Only the last set of a retirement / default may be unfinished.
            return f"score {m.score!r}: illegal set {a}-{b}"
    if m.result_type == "completed" and (won != to_win or lost >= to_win):
        return f"score {m.score!r} does not give the winner {to_win} sets"
    if lost > won and m.result_type == "completed":
        return f"score {m.score!r} says the loser won"
    return None


def _service_points(s: PlayerStats) -> int | None:
    if s.first_serve_points_played is None or s.second_serve_points_played is None:
        return None
    return s.first_serve_points_played + s.second_serve_points_played


def check_stats(m: Match) -> str | None:
    """Reason the stats contradict themselves, or None. Unknown (None) values are skipped."""
    sides = {"winner": (m.stats.winner, m.stats.loser), "loser": (m.stats.loser, m.stats.winner)}
    for name, (s, opp) in sides.items():
        def le(small, big, what):
            if small is not None and big is not None and small > big:
                return f"{name}: {what} ({small} > {big})"

        def eq(x, y, what):
            if x is not None and y is not None and x != y:
                return f"{name}: {what} ({x} != {y})"

        for field, value in s.model_dump().items():
            if value is not None and value < 0:
                return f"{name}: negative {field}"
        attempts_left = None if s.first_serve_attempts is None or s.first_serve_in is None \
            else s.first_serve_attempts - s.first_serve_in
        opp_bp_lost = None if opp.break_points_faced is None or opp.break_points_saved is None \
            else opp.break_points_faced - opp.break_points_saved
        problem = (
            le(s.first_serve_in, s.first_serve_attempts, "first serves in > attempts")
            or le(s.first_serve_points_won, s.first_serve_points_played, "first-serve points won > played")
            or le(s.second_serve_points_won, s.second_serve_points_played, "second-serve points won > played")
            or eq(s.first_serve_points_played, s.first_serve_in, "first-serve points != first serves in")
            or eq(s.second_serve_points_played, attempts_left, "second-serve points != missed first serves")
            or le(s.aces, _service_points(s), "aces > service points")
            or le(s.double_faults, s.second_serve_points_played, "double faults > second-serve points")
            or le(s.break_points_saved, s.break_points_faced, "break points saved > faced")
            or le(s.break_points_converted, s.break_point_chances, "break points converted > chances")
            or eq(s.break_point_chances, opp.break_points_faced, "break chances != opponent's break points faced")
            or eq(s.break_points_converted, opp_bp_lost, "breaks converted != opponent's break points lost")
        )
        if problem:
            return problem

    w, l = m.stats.winner, m.stats.loser
    played = [_service_points(w), _service_points(l)]
    if None not in played and w.total_points_won is not None and l.total_points_won is not None:
        if w.total_points_won + l.total_points_won != sum(played):
            return f"total points won ({w.total_points_won}+{l.total_points_won}) != points played ({sum(played)})"
    return None


# ---------------------------------------------------------------- outliers


def find_outliers(m: Match) -> list[Outlier]:
    found = []

    def flag(key: str, fact: str, reason: str):
        found.append(Outlier(id=f"{m.id}.{key}", match_id=m.id, fact=fact, reason=reason))

    if m.stats:
        for side, player in (("winner", m.winner), ("loser", m.loser)):
            s = getattr(m.stats, side)
            if s.aces is not None and s.aces >= config.OUTLIER_ACES:
                flag(f"{side}.aces", f"{player.name} hit {s.aces} aces",
                     f"aces >= {config.OUTLIER_ACES}, close to ATP single-match records")
            if s.double_faults is not None and s.double_faults >= config.OUTLIER_DOUBLE_FAULTS:
                flag(f"{side}.double_faults", f"{player.name} served {s.double_faults} double faults",
                     f"double faults >= {config.OUTLIER_DOUBLE_FAULTS}")

    if m.result_type != "walkover":
        sets = parse_score(m.score)
        if any(a == 0 and b == 6 for a, b, _ in sets):
            flag("comeback", f"{m.winner.name} beat {m.loser.name} {m.score} after losing a set 0-6",
                 "won after losing a set 0-6")
        tiebreaks = sum(1 for a, b, _ in sets if max(a, b) == 7 and min(a, b) == 6)
        if tiebreaks >= config.OUTLIER_TIEBREAKS:
            flag("tiebreaks", f"{m.winner.name} beat {m.loser.name} {m.score} with {tiebreaks} tie-breaks",
                 f"{tiebreaks} tie-breaks in one match")

    if m.winner_odds is not None and m.winner_odds >= config.OUTLIER_UPSET_ODDS:
        flag("upset", f"{m.winner.name} (pre-match odds {m.winner_odds}) beat {m.loser.name} "
             f"(odds {m.loser_odds}) {m.score}", f"winner's pre-match odds >= {config.OUTLIER_UPSET_ODDS}")
    return found


class _Check(BaseModel):
    outlier_id: str
    status: str  # "verified" | "unverified"
    evidence: list[Evidence]
    context: str | None


class _Verification(BaseModel):
    checks: list[_Check]


SUBMIT_VERIFICATION = agent.submit_tool(
    "submit_verification",
    "Hand in one check per outlier. Call exactly once, when finished.",
    _Verification,
)


def _verify(day, matches, outliers, usage, search, open_session) -> None:
    """Fills status / evidence / context on the outliers in place. Never raises:
    an outlier that can't be verified just stays unverified."""
    # Selected matches first; those are the ones most likely to be talked about.
    selected = {m.id for m in matches if m.selected}
    todo = sorted(outliers, key=lambda o: o.match_id not in selected)[: config.MAX_OUTLIERS_VERIFIED]
    by_match = {m.id: m for m in matches}
    web = agent.WebTools(day, search or TavilyClient(), usage, config.MAX_VERIFY_SEARCHES, config.MAX_VERIFY_FETCHES)

    task = "Outliers to verify (match date " + day + " UTC):\n\n" + "\n".join(
        f"- {o.id}: {o.fact}. Flagged because: {o.reason}. "
        f"Match: {by_match[o.match_id].tournament}, {by_match[o.match_id].round} round."
        for o in todo
    )
    try:
        result = agent.run_agent(
            model=config.VERIFY_MODEL,
            system=(config.PROMPTS_DIR / "verify.md").read_text(),
            task=task,
            submit=SUBMIT_VERIFICATION,
            answer=_Verification,
            usage=usage,
            tools=web.tools,
            handlers=web.handlers,
            open_session=open_session,
        )
    except agent.AgentError as e:
        usage.warnings.append(f"outlier verification failed, all left unverified: {e}")
        return

    by_id = {o.id: o for o in todo}
    for check in result.checks:
        outlier = by_id.get(check.outlier_id)
        if outlier is None:
            usage.warnings.append(f"verification of unknown outlier {check.outlier_id!r} ignored")
            continue
        evidence = []
        for ev in check.evidence:
            page = web.fetched.get(ev.url)
            if page is None:
                usage.warnings.append(f"{outlier.id}: evidence page was never opened, dropped: {ev.url}")
            elif agent.normalize(ev.excerpt) not in agent.normalize(page):
                usage.warnings.append(f"{outlier.id}: excerpt not found on {ev.url}, dropped: {ev.excerpt[:80]!r}")
            else:
                evidence.append(ev)
        if check.status == "verified" and evidence:
            outlier.status, outlier.evidence, outlier.context = "verified", evidence, check.context
        elif check.status == "verified":
            usage.warnings.append(f"{outlier.id}: marked verified without usable evidence; left unverified")
