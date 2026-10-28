"""Settings read from the environment or pipeline/.env."""

import os
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PIPELINE_DIR / "data"
CACHE_DIR = DATA_DIR / "cache"
RUNS_DIR = DATA_DIR / "runs"
PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


def _load_dotenv() -> None:
    env_file = PIPELINE_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        # Real environment variables win over the file.
        if value and key.strip() not in os.environ:
            os.environ[key.strip()] = value


_load_dotenv()


def require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set (env var or pipeline/.env)")
    return value


# Models per role, as "provider:model" (see llm.py), e.g.
#   deepseek:deepseek-v4-pro   deepseek:deepseek-flash   anthropic:claude-opus-5-5
# Override with an env var or a line in .env to compare models.
RESEARCH_MODEL = os.environ.get("RESEARCH_MODEL", "deepseek:deepseek-v4-pro")
RESEARCH_EFFORT = os.environ.get("RESEARCH_EFFORT", "high")  # low | medium | high | max

# TourRank ids: 2 main tour (250/500), 3 Masters, 4 Grand Slam, 5 Davis Cup,
# 7 Tour Finals. Leaves out 0 ITF and 1 Challenger.
MAIN_TOUR_RANKS = (2, 3, 4, 5, 7)

# Caps on the research agent's tool use per run.
MAX_STATS_CALLS = 10
MAX_WEB_SEARCHES = 8
MAX_WEB_FETCHES = 10
MAX_AGENT_TURNS = 20

# Tavily search settings. basic = 1 credit per search, advanced = 2.
TAVILY_SEARCH_DEPTH = os.environ.get("TAVILY_SEARCH_DEPTH", "basic")
TAVILY_MAX_RESULTS = 8
# Page text handed to the model is capped to keep the context small.
MAX_PAGE_CHARS = 20000
# Betting and odds sites rank well for match names but carry no analysis.
TAVILY_EXCLUDE_DOMAINS = [
    "oddschecker.com",
    "covers.com",
    "sportsgambler.com",
    "bettingexpert.com",
]

# Models for the later steps, same "provider:model" format as RESEARCH_MODEL.
# The reviewer defaults to a different vendor than the writers, so the two
# don't share blind spots.
VERIFY_MODEL = os.environ.get("VERIFY_MODEL") or RESEARCH_MODEL
EDITOR_MODEL = os.environ.get("EDITOR_MODEL", "deepseek:deepseek-v4-pro")
WRITER_MODEL = os.environ.get("WRITER_MODEL", "deepseek:deepseek-v4-pro")
META_MODEL = os.environ.get("META_MODEL", "deepseek:deepseek-flash")
REVIEWER_MODEL = os.environ.get("REVIEWER_MODEL", "anthropic:claude-opus-5-5")
AGENT_EFFORT = os.environ.get("AGENT_EFFORT", "high")

# VALIDATE: rare-but-valid values that get flagged as outliers and verified.
# First guesses; calibrate against history once we have some.
OUTLIER_ACES = 30
OUTLIER_DOUBLE_FAULTS = 12
OUTLIER_TIEBREAKS = 3  # tie-breaks in one match
OUTLIER_UPSET_ODDS = 4.0  # winner's pre-match decimal odds
MAX_OUTLIERS_VERIFIED = 6
MAX_VERIFY_SEARCHES = 6
MAX_VERIFY_FETCHES = 6

# WRITE / REVIEW
WRITE_CONCURRENCY = 4
SCRIPT_MIN_WORDS = 700
SCRIPT_MAX_WORDS = 1600
SCRIPT_MAX_LINE_WORDS = 90
MAX_REVISIONS = 2
