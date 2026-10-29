"""tennis-api.com client (RapidAPI host tennis-api-atp-wta-itf).

Every successful response is cached under data/cache/tennis_api/ so reruns and
local development don't spend the free tier's 50 requests/day.
"""

import json
from datetime import date, datetime, timezone

import httpx

from .. import config
from ..schemas import Match, MatchStats, Player, PlayerStats

HOST = "tennis-api-atp-wta-itf.p.rapidapi.com"
BASE_URL = f"https://{HOST}/tennis/v2"
CACHE_DIR = config.CACHE_DIR / "tennis_api"

LEVELS = {2: "main_tour", 3: "masters", 4: "grand_slam", 5: "davis_cup", 7: "tour_finals"}


class TennisApiError(RuntimeError):
    pass


class TennisApiClient:
    def __init__(self, api_key: str | None = None, use_cache: bool = True):
        self.api_key = api_key or config.require("RAPIDAPI_KEY")
        self.use_cache = use_cache
        self.requests = 0
        self.cache_hits = 0
        self.quota_remaining: str | None = None
        self._http = httpx.Client(
            base_url=BASE_URL,
            headers={"X-RapidAPI-Host": HOST, "X-RapidAPI-Key": self.api_key},
            timeout=30,
        )

    def _get(self, path: str, params: dict, cache_name: str | None) -> dict:
        cache_file = CACHE_DIR / cache_name if cache_name else None
        if self.use_cache and cache_file and cache_file.exists():
            self.cache_hits += 1
            return json.loads(cache_file.read_text())

        self.requests += 1
        res = self._http.get(path, params=params)
        self.quota_remaining = res.headers.get("x-ratelimit-requests-remaining")
        if res.status_code != 200:
            raise TennisApiError(f"GET {path} -> HTTP {res.status_code}: {res.text[:300]}")
        body = res.json()

        if cache_file:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(body, ensure_ascii=False, indent=2))
        return body

    def get_results(self, day: str) -> list[dict]:
        """All main-tour ATP singles results for one UTC day, across pages."""
        # Today's results are still coming in, so only past days are cached.
        cacheable = date.fromisoformat(day) < datetime.now(timezone.utc).date()
        ranks = ",".join(str(r) for r in config.MAIN_TOUR_RANKS)
        rows, page = [], 1
        while True:
            body = self._get(
                f"/atp/results/{day}",
                {
                    "pageSize": 100,
                    "pageNo": page,
                    "filter": f"PlayerGroup:singles;TourRank:{ranks}",
                    "include": "tournament,tournament.court,round",
                },
                f"results_{day}_p{page}.json" if cacheable else None,
            )
            rows += body.get("data", [])
            if not body.get("hasNextPage") or not body.get("data"):
                return rows
            page += 1

    def get_match_stats(self, match_id: str) -> dict | None:
        """Raw stats payload for a completed match, or None if there are none."""
        body = self._get(
            f"/matches/{match_id}/stats",
            {"type": "atp", "source": "game"},
            f"stats_{match_id}.json",
        )
        return body.get("data") or None


def live_match_id(row: dict) -> str:
    return f"{row['player1Id']}-{row['player2Id']}-{row['tournamentId']}-{row['roundId']}"


def _odds(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_match(row: dict) -> Match:
    """Results row -> Match. In results, player1 is always the winner."""
    t = row.get("tournament") or {}
    p1, p2 = row["player1"], row["player2"]
    return Match(
        id=live_match_id(row),
        date=row["date"],
        tournament=t.get("name") or "?",
        tournament_id=row["tournamentId"],
        level=LEVELS.get(t.get("rankId"), f"rank_{t.get('rankId')}"),
        surface=(t.get("court") or {}).get("name"),
        round=(row.get("round") or {}).get("name"),
        winner=Player(id=p1["id"], name=p1["name"], country=p1.get("countryAcr")),
        loser=Player(id=p2["id"], name=p2["name"], country=p2.get("countryAcr")),
        score=row["result"],
        result_type=row.get("result_type") or "completed",
        winner_odds=_odds(row.get("odd1")),
        loser_odds=_odds(row.get("odd2")),
    )


def _player_stats(raw: dict) -> PlayerStats:
    return PlayerStats(
        aces=raw.get("aces"),
        double_faults=raw.get("doubleFaults"),
        first_serve_in=raw.get("firstServe"),
        first_serve_attempts=raw.get("firstServeOf"),
        first_serve_points_won=raw.get("winningOnFirstServe"),
        first_serve_points_played=raw.get("winningOnFirstServeOf"),
        second_serve_points_won=raw.get("winningOnSecondServe"),
        second_serve_points_played=raw.get("winningOnSecondServeOf"),
        break_points_faced=raw.get("breakPointFacedGm"),
        break_points_saved=raw.get("breakPointSavedGm"),
        break_point_chances=raw.get("breakPointChanceGm"),
        break_points_converted=raw.get("breakPointWonGm"),
        total_points_won=raw.get("totalPointsWon"),
    )


def to_match_stats(match: Match, raw: dict) -> MatchStats:
    """Stats payload -> MatchStats, matched to winner/loser by player id."""
    p1, p2 = raw.get("player1Stats") or {}, raw.get("player2Stats") or {}
    if p1.get("player1Id") == match.loser.id:
        p1, p2 = p2, p1
    return MatchStats(winner=_player_stats(p1), loser=_player_stats(p2))
