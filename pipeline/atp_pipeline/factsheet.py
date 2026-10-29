"""How the Fact Sheet is shown to the agents after VALIDATE.

One rendering for the editor, writers and reviewer, so they all see the same
facts under the same ids. Unknown values stay null; nothing is filled in.
The research agent's selection reasons are left out: they mix in facts from
articles, which downstream must only use with attribution.
"""

import json

from .schemas import FactSheet, Match


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
        "result_type": m.result_type,
        "pre_match_odds": {"winner": m.winner_odds, "loser": m.loser_odds},
    }
    if m.stats:
        facts["stats"] = {"winner": m.stats.winner.model_dump(), "loser": m.stats.loser.model_dump()}
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
