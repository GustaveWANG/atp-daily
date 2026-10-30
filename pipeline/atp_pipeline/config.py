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
#   claude-code:sonnet   claude-code:opus   deepseek:deepseek-v4-pro   anthropic:claude-sonnet-5-5
# Every role defaults to claude-code, which uses the Claude subscription the
# `claude` CLI is logged in to, so a run costs no API money.
# Override with an env var or a line in .env to compare models.
# Per model call. Reasoning tokens count toward it, and DeepSeek can spend
# 20k+ thinking before writing a full script.
MAX_OUTPUT_TOKENS = int(os.environ.get("MAX_OUTPUT_TOKENS", "64000"))

RESEARCH_MODEL = os.environ.get("RESEARCH_MODEL", "claude-code:sonnet")
RESEARCH_EFFORT = os.environ.get("RESEARCH_EFFORT", "high")  # low | medium | high | max

# TourRank ids: 2 main tour (250/500), 3 Masters, 4 Grand Slam, 5 Davis Cup,
# 7 Tour Finals. Leaves out 0 ITF and 1 Challenger.
MAIN_TOUR_RANKS = (2, 3, 4, 5, 7)

# Caps on the research agent's tool use per run.
MAX_STATS_CALLS = 10
MAX_WEB_SEARCHES = 20
MAX_WEB_FETCHES = 22
MAX_AGENT_TURNS = 30
# How far back a "background" search (player news, form, history) looks.
BACKGROUND_SEARCH_DAYS = 45
# A "style" search (how a player plays: strokes, serve, equipment, tactics) can use
# older scouting pieces, since a game changes slowly.
STYLE_SEARCH_DAYS = 3 * 365

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
    # Social and video pages: can't be read as text or cited, and they crowd out
    # real analysis, especially in "style" searches.
    "facebook.com",
    "instagram.com",
    "youtube.com",
    "tiktok.com",
    "reddit.com",
    "x.com",
    "twitter.com",
]

# Models for the later steps, same "provider:model" format as RESEARCH_MODEL.
# The reviewer defaults to a different model than the writers, so the two
# share fewer blind spots.
VERIFY_MODEL = os.environ.get("VERIFY_MODEL") or RESEARCH_MODEL
EDITOR_MODEL = os.environ.get("EDITOR_MODEL", "claude-code:sonnet")
WRITER_MODEL = os.environ.get("WRITER_MODEL", "claude-code:sonnet")
META_MODEL = os.environ.get("META_MODEL", "claude-code:haiku")
REVIEWER_MODEL = os.environ.get("REVIEWER_MODEL", "claude-code:opus")
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

# Dialogue checks on the script (write.dialogue_stats). "minor" only reports
# them; switch to "blocking" once the script prompt teaches real back-and-forth,
# so a flat script gets sent back for a rewrite.
DIALOGUE_SEVERITY = "minor"
DIALOGUE_MIN_QUESTIONS = 4  # lines with a real question in them
DIALOGUE_MIN_SHORT_LINES = 4  # quick reactions of at most DIALOGUE_SHORT_LINE_WORDS
DIALOGUE_SHORT_LINE_WORDS = 8
DIALOGUE_MAX_SAME_SPEAKER = 1  # times one host speaks twice in a row
DIALOGUE_MAX_RELAY_SHARE = 0.2  # lines opening with "And", "Plus"... that just add the next fact
# Number density: spoken numbers (scores, stats, counts) per 100 words, and "percent" mentions.
# Earlier 2026-10-27 scripts ran at 9-12 per 100 words and felt like a stat sheet.
NUMBERS_MAX_PER_100_WORDS = 6
NUMBERS_MAX_PERCENT = 3

# EVALS: the judge grading a step's output.
EVAL_MODEL = os.environ.get("EVAL_MODEL", "claude-code:sonnet")

# PRODUCE: ElevenLabs TTS, one request per script line.
# multilingual_v2 is ElevenLabs' steadiest model for long-form and takes the
# neighbouring lines as context. Voice ids are from the Voice Library; override
# in .env to try others.
TTS_MODEL = os.environ.get("TTS_MODEL", "eleven_multilingual_v2")
TTS_OUTPUT_FORMAT = "mp3_44100_128"
TTS_VOICES = {
    "ALEX": os.environ.get("ELEVENLABS_VOICE_ALEX", "OZxMHsGaBmV5pjMIDIn0"),  # Amy
    "SAM": os.environ.get("ELEVENLABS_VOICE_SAM", "7EzWGsX10sAS4c9m9cPf"),  # Jack
}
TTS_VOICE_SETTINGS = {"stability": 0.45, "similarity_boost": 0.75, "style": 0.15, "use_speaker_boost": True}
# Concurrent requests allowed for multilingual_v2: Free 2, Starter 3, Creator 5, Pro 10.
TTS_CONCURRENCY = int(os.environ.get("TTS_CONCURRENCY", "2"))
TTS_MAX_ATTEMPTS = 3  # per line: first take plus re-rolls with a new seed when QA fails

# Audio QA: speech-to-text each line and compare it with the script.
STT_MODEL = "scribe_v2"
QA_MIN_SIMILARITY = 0.85  # word-level match, transcript vs script line
QA_MIN_WORDS_PER_SEC = 1.4  # slower usually means stalls or garbage
QA_MAX_WORDS_PER_SEC = 4.2  # faster usually means skipped words
QA_RATE_MIN_WORDS = 10  # short lines are read fast or slow naturally; the transcript check covers them
QA_MAX_SILENCE = 1.2  # seconds of silence allowed inside a line
QA_SILENCE_DB = -45

# Stitching
LINE_GAP = 0.3  # seconds between lines
SEGMENT_GAP = 0.8  # between segments (and around the intro / outro)
AUDIO_SAMPLE_RATE = 44100
AUDIO_BITRATE = "128k"
AUDIO_LOUDNESS_LUFS = -16  # podcast standard

# PUBLISH: Supabase, which the website reads. SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY come from the environment or .env.
PUBLISH_BUCKET = "audio"  # public Storage bucket; files go to episodes/<date>.mp3
