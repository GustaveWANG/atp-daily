"""Probe tennis-api.com (RapidAPI free tier) before building Discover on it.

Pulls one day's ATP singles results plus stats for a few matches, saves the
raw JSON under pipeline/data/probe/, and prints a short summary.

Usage:
    python3 pipeline/scripts/probe_tennis_api.py [YYYY-MM-DD] [--stats N]

Reads RAPIDAPI_KEY from the environment or from pipeline/.env.
Uses about 1-2 requests for results + N for stats (default 3).
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

HOST = "tennis-api-atp-wta-itf.p.rapidapi.com"
BASE_URL = f"https://{HOST}/tennis/v2"
PIPELINE_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = PIPELINE_DIR / "data" / "probe"
# TourRank ids: 2 main tour (250/500), 3 Masters, 4 Grand Slam, 5 Davis Cup,
# 7 Tour Finals. Leaves out 0 ITF and 1 Challenger.
MAIN_TOUR_RANKS = "2,3,4,5,7"

requests_used = 0


def load_key():
    key = os.environ.get("RAPIDAPI_KEY")
    env_file = PIPELINE_DIR / ".env"
    if not key and env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("RAPIDAPI_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit("RAPIDAPI_KEY not set (env var or pipeline/.env)")
    return key


def get(path, key):
    global requests_used
    requests_used += 1
    req = urllib.request.Request(
        BASE_URL + path,
        headers={"X-RapidAPI-Host": HOST, "X-RapidAPI-Key": key},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            remaining = res.headers.get("x-ratelimit-requests-remaining")
            return res.status, json.load(res), remaining
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")}, None


def save(name, payload):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / name
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    return path


def live_match_id(row):
    # Results ids get renumbered; liveMatchId is the stable one per the docs.
    if row.get("liveMatchId"):
        return row["liveMatchId"]
    p1, p2 = row.get("player1", {}).get("id"), row.get("player2", {}).get("id")
    tid = row.get("tournamentId") or row.get("tournament", {}).get("id")
    rid = row.get("roundId") or row.get("round", {}).get("id")
    if all([p1, p2, tid, rid]):
        return f"{p1}-{p2}-{tid}-{rid}"
    return row.get("matchId") or row.get("id")


def main():
    args = sys.argv[1:]
    n_stats = 3
    if "--stats" in args:
        i = args.index("--stats")
        n_stats = int(args[i + 1])
        del args[i : i + 2]
    day = args[0] if args else (date.today() - timedelta(days=1)).isoformat()
    key = load_key()

    # 1. Main-tour ATP singles results for the day (paged).
    rows, page = [], 1
    while True:
        status, body, remaining = get(
            f"/atp/results/{day}?pageSize=100&pageNo={page}"
            f"&filter=PlayerGroup:singles;TourRank:{MAIN_TOUR_RANKS}"
            "&include=tournament,tournament.court,round",
            key,
        )
        save(f"results_{day}_p{page}.json", body)
        print(f"results page {page}: HTTP {status}, quota remaining: {remaining}")
        if status != 200:
            print(json.dumps(body, ensure_ascii=False)[:500])
            return
        rows += body.get("data", [])
        if not body.get("hasNextPage") or not body.get("data"):
            break
        page += 1

    print(f"\n{day}: {len(rows)} ATP singles results")
    by_tournament = {}
    for r in rows:
        t = r.get("tournament") or {}
        court = (t.get("court") or {}).get("name", "?")
        label = f"{t.get('name', '?')} (rank {t.get('rankId', '?')}, {court})"
        by_tournament.setdefault(label, []).append(r)
    for label, rs in by_tournament.items():
        print(f"\n  {label}: {len(rs)} matches")
        for r in rs:
            print(
                f"    {r.get('player1', {}).get('name')} d. "
                f"{r.get('player2', {}).get('name')}  {r.get('result')}"
                f"  [{r.get('result_type')}]  id={live_match_id(r)}"
            )

    # 2. Stats for the first few completed (non-walkover) matches.
    # Prefer main-tour matches (higher tournament rank) over Challengers.
    candidates = sorted(
        (r for r in rows if r.get("result_type") != "walkover"),
        key=lambda r: -((r.get("tournament") or {}).get("rankId") or 0),
    )
    print()
    for r in candidates[:n_stats]:
        mid = live_match_id(r)
        status, body, remaining = get(f"/matches/{mid}/stats?type=atp&source=game", key)
        save(f"stats_{mid}.json", body)
        p1 = (body.get("data") or {}).get("player1Stats") if status == 200 else None
        print(
            f"stats {r.get('player1', {}).get('name')} vs {r.get('player2', {}).get('name')}: "
            f"HTTP {status}, quota remaining: {remaining}"
        )
        if p1:
            print(
                f"    aces={p1.get('aces')} df={p1.get('doubleFaults')} "
                f"1st in={p1.get('firstServe')}/{p1.get('firstServeOf')} "
                f"bp saved={p1.get('breakPointSavedGm')}/{p1.get('breakPointFacedGm')}"
            )
        else:
            print("    " + json.dumps(body, ensure_ascii=False)[:300])

    print(f"\nrequests used this run: {requests_used}; raw JSON in {OUT_DIR}")


if __name__ == "__main__":
    main()
