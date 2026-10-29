"""Data handed from one pipeline step to the next."""

from typing import Literal

from pydantic import BaseModel, Field


class Player(BaseModel):
    id: int  # tennis-api's own id, not the ATP id
    name: str
    country: str | None = None


class PlayerStats(BaseModel):
    # None means the API did not provide it (unknown), never 0.
    aces: int | None = None
    double_faults: int | None = None
    first_serve_in: int | None = None
    first_serve_attempts: int | None = None
    first_serve_points_won: int | None = None
    first_serve_points_played: int | None = None
    second_serve_points_won: int | None = None
    second_serve_points_played: int | None = None
    break_points_faced: int | None = None
    break_points_saved: int | None = None
    break_point_chances: int | None = None
    break_points_converted: int | None = None
    total_points_won: int | None = None


class MatchStats(BaseModel):
    winner: PlayerStats
    loser: PlayerStats


class Match(BaseModel):
    """A completed match. Every field comes from the tennis API, never from a model."""

    id: str  # liveMatchId: player1Id-player2Id-tournamentId-roundId (stable)
    date: str  # ISO-8601 UTC
    tournament: str
    tournament_id: int
    level: str  # main_tour | masters | grand_slam | davis_cup | tour_finals
    surface: str | None
    round: str | None
    winner: Player
    loser: Player
    score: str
    result_type: str  # completed | retired | walkover | default
    winner_odds: float | None = None  # pre-match decimal odds
    loser_odds: float | None = None
    stats: MatchStats | None = None
    # Set by the research agent.
    selected: bool = False
    selection_reason: str | None = None


class Article(BaseModel):
    """Opinion / analysis found on the web. Not a source of match facts."""

    id: str
    url: str
    source: str
    title: str | None = None
    published_at: str | None = None
    match_ids: list[str]
    key_points: list[str]
    notable_quote: str | None = None
    # match_report: about yesterday's matches. background: a player's news, form or history.
    kind: Literal["match_report", "background"] = "match_report"


class SourceMeta(BaseModel):
    tennis_api_requests: int = 0
    tennis_api_cache_hits: int = 0
    tavily_requests: int = 0
    tavily_cache_hits: int = 0
    tavily_credits: float = 0
    model: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    web_searches: int = 0
    web_fetches: int = 0
    warnings: list[str] = Field(default_factory=list)


class DiscoverOutput(BaseModel):
    target_date: str
    matches: list[Match]
    articles: list[Article]
    source_meta: SourceMeta


class StepUsage(BaseModel):
    """Model usage of one step, summed over all its calls."""

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    web_searches: int = 0
    web_fetches: int = 0
    warnings: list[str] = Field(default_factory=list)

    def add(self, other: "StepUsage") -> None:
        self.calls += other.calls
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.web_searches += other.web_searches
        self.web_fetches += other.web_fetches
        self.warnings += other.warnings


# ------------------------------------------------------------------ VALIDATE


class Evidence(BaseModel):
    url: str
    source: str
    excerpt: str  # copied from the page; checked to appear in it


class Outlier(BaseModel):
    """A rare but valid value. Never blocks; verified against the web if possible."""

    id: str  # e.g. "<match_id>.winner.aces"
    match_id: str
    fact: str
    reason: str
    status: Literal["verified", "unverified"] = "unverified"
    evidence: list[Evidence] = Field(default_factory=list)
    context: str | None = None  # background the source adds, e.g. "third most since 1991"


class Rejection(BaseModel):
    """Impossible data kept out of the Fact Sheet."""

    match_id: str
    scope: Literal["match", "stats"]  # whole match dropped, or only its stats
    reason: str


class FactSheet(BaseModel):
    target_date: str
    no_show: bool  # no matches: off day, nothing to make
    matches: list[Match]
    articles: list[Article]
    outliers: list[Outlier]
    rejected: list[Rejection]
    usage: StepUsage


# ---------------------------------------------------------------------- PLAN


class Segment(BaseModel):
    title: str  # becomes a chapter title
    angle: str  # the storyline in one or two sentences
    take: str = ""  # the point of view the segment argues; empty in outlines made before it existed
    match_ids: list[str]
    article_ids: list[str]
    outlier_ids: list[str]
    talking_points: list[str]


class Outline(BaseModel):
    target_date: str
    episode_angle: str
    segments: list[Segment]
    quick_hits: list[str]  # match ids mentioned briefly at the end
    usage: StepUsage


# --------------------------------------------------------------------- WRITE


class ScriptLine(BaseModel):
    speaker: Literal["ALEX", "SAM"]
    text: str
    segment: int | None  # index into Outline.segments; None for intro / quick hits / outro


class Recap(BaseModel):
    match_id: str
    text: str  # paragraphs separated by blank lines


class EpisodeMeta(BaseModel):
    title: str
    headline: str
    the_read: str  # a short analytical take on the day
    bracket_watch: str | None  # what's next; only when an article says so


class ReviewIssue(BaseModel):
    severity: Literal["blocking", "minor"]
    target: str  # "script", "meta", or "recap:<match_id>"
    line: int | None  # script line number, when target is "script"
    issue: str
    suggestion: str


class Draft(BaseModel):
    target_date: str
    script: list[ScriptLine]
    recaps: list[Recap]
    meta: EpisodeMeta
    chapter_titles: list[str]
    format_issues: list[ReviewIssue]  # found by code, not by the reviewer
    usage: StepUsage


# -------------------------------------------------------------------- REVIEW


class ReviewRound(BaseModel):
    round: int
    passed: bool
    issues: list[ReviewIssue]


class ReviewOutput(BaseModel):
    target_date: str
    status: Literal["passed", "needs_review"]
    rounds: list[ReviewRound]
    draft: Draft  # the final, possibly revised draft
    usage: StepUsage


# ------------------------------------------------------------------- PRODUCE


class AudioLine(BaseModel):
    index: int  # 1-based, matches render_script's numbering
    speaker: Literal["ALEX", "SAM"]
    file: str  # relative to the run's audio/ dir
    duration: float  # seconds, from ffprobe
    transcript: str  # what speech-to-text heard
    similarity: float  # 0..1, transcript vs script line
    attempts: int
    issues: list[str]  # empty when the line passed QA


class AudioUsage(BaseModel):
    tts_requests: int = 0
    tts_characters: int = 0  # billed; cache hits excluded
    stt_requests: int = 0
    stt_seconds: float = 0
    cache_hits: int = 0


class ProduceOutput(BaseModel):
    target_date: str
    status: Literal["passed", "needs_review"]
    script_hash: str  # the audio belongs to this exact script
    audio_file: str  # relative to the run dir
    duration: float  # seconds, of the stitched episode
    tts_model: str
    voices: dict[str, str]  # speaker -> ElevenLabs voice id
    lines: list[AudioLine]
    usage: AudioUsage
