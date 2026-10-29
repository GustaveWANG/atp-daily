"""How the Fact Sheet is shown to the agents after VALIDATE.

One rendering for the editor, writers and reviewer, so they all see the same
facts under the same ids. Unknown values stay null; nothing is filled in.
The research agent's selection reasons are left out: they mix in facts from
articles, which downstream must only use with attribution.
"""

import json
import re

from .schemas import FactSheet, Match

# Derived values are worked out here, not left to the models: they misread
# counts as percentages ("first_serve_in": 80 as 80%) and the tie-break
# notation 7-6(11) as 11-9.
SET_SCORE = re.compile(r"^(\d+)-(\d+)(?:\((\d+)\))?$")
PERCENTAGES = {  # name: (numerator, denominator)
    "first_serve_in_pct": ("first_serve_in", "first_serve_attempts"),
    "first_serve_points_won_pct": ("first_serve_points_won", "first_serve_points_played"),
    "second_serve_points_won_pct": ("second_serve_points_won", "second_serve_points_played"),
}


def sets(score: str) -> list[dict]:
    """Each set from the match winner's side, with tie-break points spelled out.
    In 7-6(11) the bracket is the set loser's tie-break points; the set winner
    has two more, or seven if that's higher."""
    out = []
    for token in score.split():
        found = SET_SCORE.match(token)
        if not found:
            out.append({"games": token})
            continue
        w, l, tb = int(found[1]), int(found[2]), found[3]
        s = {"games": f"{w}-{l}", "set_won_by": "winner" if w > l else "loser"}
        if tb is not None:
            low, high = int(tb), max(7, int(tb) + 2)
            s["tiebreak_points"] = f"{high}-{low}" if w > l else f"{low}-{high}"
        out.append(s)
    return out


def _with_percentages(side: dict) -> dict:
    for name, (num, den) in PERCENTAGES.items():
        if side.get(num) is not None and side.get(den):
            side[name] = round(100 * side[num] / side[den])
    return side


def match_facts(m: Match) -> dict:
    facts = {
        "id": m.id,
        "tournament": m.tournament,
        "level": m.level,
        "surface": m.surface,
        "round": m.round,
        "winner": f"{m.winner.name} ({m.winner.country})",
        "loser": f"{m.loser.name} ({m.loser.country})",
        "score": m.score,
        "sets": sets(m.score),
        "result_type": m.result_type,
        "pre_match_odds": {"winner": m.winner_odds, "loser": m.loser_odds},
    }
    if m.winner_odds and m.loser_odds and m.winner_odds != m.loser_odds:
        facts["pre_match_odds"]["favourite"] = m.winner.name if m.winner_odds < m.loser_odds else m.loser.name
    if m.stats:
        facts["stats"] = {"winner": _with_percentages(m.stats.winner.model_dump()),
                          "loser": _with_percentages(m.stats.loser.model_dump())}
    return facts


def render(sheet: FactSheet, match_ids: list[str] | None = None) -> str:
    """The Fact Sheet as JSON, optionally limited to some matches (and the
    articles and outliers about them)."""
    keep = set(match_ids) if match_ids is not None else {m.id for m in sheet.matches}
    data = {
        "date": sheet.target_date,
        "matches": [match_facts(m) for m in sheet.matches if m.id in keep],
        "articles": [
            a.model_dump(include={"id", "source", "title", "url", "kind", "match_ids", "key_points", "notable_quote"})
            for a in sheet.articles if keep & set(a.match_ids)
        ],
        "outliers": [
            o.model_dump(include={"id", "match_id", "fact", "status", "context"})
            for o in sheet.outliers if o.match_id in keep
        ],
    }
    return json.dumps(data, ensure_ascii=False, indent=1)
