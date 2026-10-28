"""Step 1 - DISCOVER.

Code pulls every main-tour result for the day (facts never depend on the
model). The research agent then picks the matches worth covering, pulls their
stats, and finds analysis on the web through Tavily. The model is reached
through llm.py, so any supported vendor can play the agent. Its picks and articles
are checked against what it actually saw before they are returned.
"""

import json
import re
import unicodedata
from datetime import date, timedelta

from pydantic import BaseModel, ValidationError

from .. import config, llm
from ..schemas import Article, DiscoverOutput, Match, SourceMeta
from ..tools.tavily import TavilyClient, TavilyError
from ..tools.tennis_api import TennisApiClient, to_match, to_match_stats

GET_MATCH_STATS_TOOL = llm.Tool(
    name="get_match_stats",
    description=(
        "Serve and return statistics for one of the listed matches: aces, double faults, "
        "first/second serve points, break points faced/saved/converted, total points won. "
        "A null value means the data source does not track it. Walkovers have no stats."
    ),
    parameters={
        "type": "object",
        "properties": {"match_id": {"type": "string", "description": "Match id from the results list."}},
        "required": ["match_id"],
        "additionalProperties": False,
    },
)

WEB_SEARCH_TOOL = llm.Tool(
    name="web_search",
    description=(
        "Search the web. Results are limited to pages published from the day before the "
        "matches to two days after. Returns title, url, published date and a short snippet "
        "for each result. Snippets are not enough to cite; open a page with web_fetch first."
    ),
    parameters={
        "type": "object",
        "properties": {"query": {"type": "string", "description": "Search query, e.g. player names and tournament."}},
        "required": ["query"],
        "additionalProperties": False,
    },
)

WEB_FETCH_TOOL = llm.Tool(
    name="web_fetch",
    description="Open a page from your search results and return its text. Only URLs returned by web_search work.",
    parameters={
        "type": "object",
        "properties": {"url": {"type": "string", "description": "A URL from a web_search result."}},
        "required": ["url"],
        "additionalProperties": False,
    },
)

SUBMIT_RESEARCH_TOOL = llm.Tool(
    name="submit_research",
    description="Hand in the final research. Call exactly once, when finished.",
    parameters={
        "type": "object",
        "properties": {
            "selected_matches": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "match_id": {"type": "string"},
                        "reason": {"type": "string", "description": "One sentence: why this match is worth covering."},
                    },
                    "required": ["match_id", "reason"],
                    "additionalProperties": False,
                },
            },
            "articles": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "URL you opened with web_fetch."},
                        "source": {"type": "string", "description": "Publication name, e.g. ATP Tour."},
                        "title": {"type": ["string", "null"]},
                        "published_at": {"type": ["string", "null"], "description": "ISO date if known."},
                        "match_ids": {"type": "array", "items": {"type": "string"}},
                        "key_points": {"type": "array", "items": {"type": "string"}},
                        "notable_quote": {
                            "type": ["string", "null"],
                            "description": "One quote copied exactly from the article, or null.",
                        },
                    },
                    "required": ["url", "source", "title", "published_at", "match_ids", "key_points", "notable_quote"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["selected_matches", "articles"],
        "additionalProperties": False,
    },
)

TOOLS = [GET_MATCH_STATS_TOOL, WEB_SEARCH_TOOL, WEB_FETCH_TOOL, SUBMIT_RESEARCH_TOOL]


class _Pick(BaseModel):
    match_id: str
    reason: str


class _RawArticle(BaseModel):
    url: str
    source: str
    title: str | None = None
    published_at: str | None = None
    match_ids: list[str]
    key_points: list[str]
    notable_quote: str | None = None


class _Submission(BaseModel):
    """Shape of submit_research arguments. Checked in code because not every
    vendor can enforce a tool's schema."""

    selected_matches: list[_Pick]
    articles: list[_RawArticle]


class DiscoverError(RuntimeError):
    pass


def run(
    day: str,
    tennis: TennisApiClient | None = None,
    search: TavilyClient | None = None,
    open_session=llm.open_session,
) -> DiscoverOutput:
    tennis = tennis or TennisApiClient()
    meta = SourceMeta(model=config.RESEARCH_MODEL)

    matches = [to_match(row) for row in tennis.get_results(day)]
    if not matches:
        # Off day. VALIDATE turns this into NO_SHOW; no point paying for the agent.
        meta.tennis_api_requests, meta.tennis_api_cache_hits = tennis.requests, tennis.cache_hits
        return DiscoverOutput(target_date=day, matches=[], articles=[], source_meta=meta)

    search = search or TavilyClient()
    system = (config.PROMPTS_DIR / "research.md").read_text()
    session = open_session(config.RESEARCH_MODEL, system, TOOLS, config.RESEARCH_EFFORT)
    agent = _ResearchAgent(day, matches, tennis, search, session, meta)
    submission = agent.run()
    articles = _accept_submission(submission, matches, agent, meta)

    # Selected matches always get stats, whether or not the agent asked for them.
    for m in matches:
        if m.selected and m.stats is None and m.result_type != "walkover":
            _attach_stats(m, tennis)

    meta.tennis_api_requests, meta.tennis_api_cache_hits = tennis.requests, tennis.cache_hits
    meta.tavily_requests, meta.tavily_cache_hits = search.requests, search.cache_hits
    meta.tavily_credits = search.credits
    return DiscoverOutput(target_date=day, matches=matches, articles=articles, source_meta=meta)


def _attach_stats(match: Match, tennis: TennisApiClient) -> None:
    raw = tennis.get_match_stats(match.id)
    if raw:
        match.stats = to_match_stats(match, raw)


class _ResearchAgent:
    def __init__(self, day, matches, tennis, search, session: llm.ChatSession, meta):
        self.day = day
        self.matches = {m.id: m for m in matches}
        self.tennis = tennis
        self.search = search
        self.session = session
        self.meta = meta
        self.stats_calls = 0
        d = date.fromisoformat(day)
        self.search_window = ((d - timedelta(days=1)).isoformat(), (d + timedelta(days=2)).isoformat())
        self.seen_urls: set[str] = set()  # every URL returned by web_search
        self.fetched: dict[str, str] = {}  # url -> page text the model read

    def run(self) -> _Submission:
        results = [
            {
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
            for m in self.matches.values()
        ]
        self.session.add_user(
            f"Results for {self.day} (UTC), {len(results)} main-tour singles matches:\n\n"
            f"{json.dumps(results, ensure_ascii=False, indent=1)}\n\n"
            f"Budget for this run: {config.MAX_STATS_CALLS} get_match_stats calls, "
            f"{config.MAX_WEB_SEARCHES} web_search calls, {config.MAX_WEB_FETCHES} web_fetch calls. "
            "Calls over a limit are refused."
        )

        nudged = False
        for _ in range(config.MAX_AGENT_TURNS):
            turn = self.session.step()
            self.meta.input_tokens += turn.input_tokens
            self.meta.output_tokens += turn.output_tokens

            if turn.stop == "refusal":
                raise DiscoverError(f"research agent refused: {turn.stop_detail}")
            if turn.stop == "max_tokens":
                raise DiscoverError("research agent hit max_tokens")

            if turn.tool_calls:
                results, submission = [], None
                for call in turn.tool_calls:
                    result, accepted = self._run_tool(call)
                    results.append(result)
                    submission = submission or accepted
                if submission:
                    return submission
                self.session.add_tool_results(results)
                continue
            if nudged:
                raise DiscoverError(f"research agent ended without calling submit_research ({turn.stop_detail})")
            nudged = True
            self.session.add_user("Please hand in your research by calling submit_research.")

        raise DiscoverError(f"research agent did not finish within {config.MAX_AGENT_TURNS} turns")

    def _run_tool(self, call: llm.ToolCall) -> tuple[llm.ToolResult, _Submission | None]:
        def result(content: str, is_error: bool = False) -> llm.ToolResult:
            return llm.ToolResult(call_id=call.id, content=content, is_error=is_error)

        args = call.arguments
        if not isinstance(args, dict):
            return result(f"Arguments were not valid JSON: {call.raw_arguments[:200]}", is_error=True), None
        try:
            if call.name == "submit_research":
                try:
                    return result("Received."), _Submission.model_validate(args)
                except ValidationError as e:
                    # Let the model fix its submission instead of failing the run.
                    return result(f"Submission does not match the schema, fix and resubmit: {e}", is_error=True), None
            if call.name == "get_match_stats":
                return result(*self._match_stats(str(args.get("match_id", "")))), None
            if call.name == "web_search":
                return result(*self._web_search(str(args.get("query", "")))), None
            if call.name == "web_fetch":
                return result(*self._web_fetch(str(args.get("url", "")))), None
        except TavilyError as e:
            # A failed search or page shouldn't sink the run; let the agent try something else.
            self.meta.warnings.append(f"{call.name} failed: {e}")
            return result(f"{call.name} failed: {e}", is_error=True), None
        return result(f"Unknown tool {call.name}", is_error=True), None

    def _match_stats(self, match_id: str) -> tuple[str, bool]:
        match = self.matches.get(match_id)
        if match is None:
            return "No match with that id in the results list.", True
        if match.result_type == "walkover":
            return "Walkover: no match was played, so there are no stats.", False
        if match.stats is None:
            if self.stats_calls >= config.MAX_STATS_CALLS:
                return "Stats call limit reached for this run.", True
            self.stats_calls += 1
            _attach_stats(match, self.tennis)
        if match.stats is None:
            return "The data source has no stats for this match.", False
        return match.stats.model_dump_json(), False

    def _web_search(self, query: str) -> tuple[str, bool]:
        if self.meta.web_searches >= config.MAX_WEB_SEARCHES:
            return "Search limit reached for this run.", True
        self.meta.web_searches += 1
        hits = self.search.search(query, *self.search_window)
        self.seen_urls.update(h["url"] for h in hits)
        return json.dumps([
            {
                "title": h.get("title"),
                "url": h["url"],
                "published_date": h.get("published_date"),
                "snippet": h.get("content"),
            }
            for h in hits
        ], ensure_ascii=False), False

    def _web_fetch(self, url: str) -> tuple[str, bool]:
        if url in self.fetched:
            return self.fetched[url], False
        if url not in self.seen_urls:
            return "Only URLs returned by web_search can be opened.", True
        if self.meta.web_fetches >= config.MAX_WEB_FETCHES:
            return "Page fetch limit reached for this run.", True
        self.meta.web_fetches += 1
        # Keep exactly what the model sees: quotes are later checked against this text.
        text = self.search.extract(url)[: config.MAX_PAGE_CHARS]
        self.fetched[url] = text
        return text, False


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", text).strip().lower()


# Punctuation and quote marks a model may add or swap at a quote's edges, e.g.
# ending on "." where the article has '," he said'. The words inside must still match.
# "!" and "?" are kept: they change what the quote says.
_QUOTE_EDGES = " \t\n.,;:\"'“”‘’«»"


def _trim_quote(quote: str) -> str:
    return quote.strip(_QUOTE_EDGES)


def _accept_submission(submission: _Submission, matches: list[Match], agent: _ResearchAgent, meta: SourceMeta) -> list[Article]:
    """Apply the agent's picks and keep only articles and quotes we can trace."""
    by_id = {m.id: m for m in matches}
    for pick in submission.selected_matches:
        match = by_id.get(pick.match_id)
        if match is None:
            meta.warnings.append(f"selected unknown match id {pick.match_id!r}; ignored")
            continue
        match.selected, match.selection_reason = True, pick.reason

    articles = []
    for raw in submission.articles:
        url = raw.url
        if any(a.url == url for a in articles):
            meta.warnings.append(f"duplicate article, kept the first: {url}")
            continue
        if url not in agent.fetched:
            meta.warnings.append(f"article not opened with web_fetch, dropped: {url}")
            continue
        match_ids = [mid for mid in raw.match_ids if mid in by_id]
        if len(match_ids) != len(raw.match_ids):
            meta.warnings.append(f"article {url} referenced unknown match ids; removed them")
        if not match_ids:
            meta.warnings.append(f"article {url} is about none of the day's matches, dropped")
            continue
        quote = _trim_quote(raw.notable_quote or "") or None
        if quote and _normalize(quote) not in _normalize(agent.fetched[url]):
            meta.warnings.append(f"quote not found verbatim in {url}, removed: {quote[:80]!r}")
            quote = None
        articles.append(Article(
            id=f"a{len(articles) + 1}",
            url=url,
            source=raw.source,
            title=raw.title,
            published_at=raw.published_at,
            match_ids=match_ids,
            key_points=raw.key_points,
            notable_quote=quote,
        ))
    return articles
