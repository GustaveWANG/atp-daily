"""The tool-use loop shared by every agent after DISCOVER.

An agent gets a task, may call some tools, and hands in its answer by calling
a submit tool whose arguments are a pydantic model. The arguments are checked
in code (not every vendor enforces a tool schema), and the model is asked to
fix and resubmit when they don't fit, instead of failing the run.
"""

import json
import re
import unicodedata
from collections.abc import Callable
from datetime import date, timedelta
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from . import config, llm
from .schemas import StepUsage
from .tools.tavily import TavilyClient, TavilyError

M = TypeVar("M", bound=BaseModel)

# A tool handler takes the call's arguments and returns (content, is_error).
Handler = Callable[[dict], tuple[str, bool]]


class AgentError(RuntimeError):
    pass


def normalize(text: str) -> str:
    """For checking that a quote or excerpt appears in a page: ignores case,
    whitespace and curly vs straight quotes."""
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", text).strip().lower()


def strict_schema(model: type[BaseModel]) -> dict:
    """JSON Schema for a pydantic model, in the form strict tool use accepts:
    no $refs, every property required, no extra properties."""
    schema = model.model_json_schema()
    defs = schema.pop("$defs", {})

    def fix(node):
        if isinstance(node, list):
            return [fix(n) for n in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            return fix(defs[node["$ref"].split("/")[-1]])
        node = {k: fix(v) for k, v in node.items() if k not in ("title", "default")}
        if node.get("type") == "object" and "properties" in node:
            node["required"] = list(node["properties"])
            node["additionalProperties"] = False
        return node

    return fix(schema)


def submit_tool(name: str, description: str, model: type[BaseModel]) -> llm.Tool:
    return llm.Tool(name=name, description=description, parameters=strict_schema(model))


def run_agent(
    *,
    model: str,
    system: str,
    task: str,
    submit: llm.Tool,
    answer: type[M],
    usage: StepUsage,
    tools: list[llm.Tool] = (),
    handlers: dict[str, Handler] | None = None,
    check: Callable[[M], str | None] | None = None,
    max_turns: int = config.MAX_AGENT_TURNS,
    effort: str = config.AGENT_EFFORT,
    open_session=None,
) -> M:
    """Run one agent to completion and return its validated submission.

    check: extra rules on the submission (e.g. ids must exist); return an error
    message to have the model fix it, or None to accept.
    """
    handlers = handlers or {}
    session = (open_session or llm.open_session)(model, system, [*tools, submit], effort)
    session.add_user(task)
    usage.calls += 1

    nudged = False
    for _ in range(max_turns):
        turn = session.step()
        usage.input_tokens += turn.input_tokens
        usage.output_tokens += turn.output_tokens
        if turn.stop == "refusal":
            raise AgentError(f"{submit.name}: model refused: {turn.stop_detail}")
        if turn.stop == "max_tokens":
            raise AgentError(f"{submit.name}: model hit max_tokens")

        if not turn.tool_calls:
            if nudged:
                raise AgentError(f"{submit.name}: model ended without submitting ({turn.stop_detail})")
            nudged = True
            session.add_user(f"Please hand in your answer by calling {submit.name}.")
            continue

        results, accepted = [], None
        for call in turn.tool_calls:
            content, is_error = "", False
            args = call.arguments
            if not isinstance(args, dict):
                content, is_error = f"Arguments were not valid JSON: {call.raw_arguments[:200]}", True
            elif call.name == submit.name:
                try:
                    parsed = answer.model_validate(args)
                    problem = check(parsed) if check else None
                except ValidationError as e:
                    problem = f"Submission does not match the schema: {e}"
                if problem:
                    content, is_error = f"{problem}\nFix this and call {submit.name} again.", True
                else:
                    content, accepted = "Received.", parsed
            elif call.name in handlers:
                content, is_error = handlers[call.name](args)
            else:
                content, is_error = f"Unknown tool {call.name}", True
            results.append(llm.ToolResult(call_id=call.id, content=content, is_error=is_error))
        if accepted is not None:
            return accepted
        session.add_tool_results(results)

    raise AgentError(f"{submit.name}: no valid submission within {max_turns} turns")


class WebTools:
    """web_search / web_fetch for an agent, with caps, keeping every page it read.

    Search results are limited to the day before the matches through two days
    after, and only URLs that came back from a search can be fetched.
    """

    SEARCH = llm.Tool(
        name="web_search",
        description=(
            "Search the web. Results are limited to pages published around the match day. "
            "Returns title, url, published date and a short snippet per result. Snippets are "
            "not enough to cite; open a page with web_fetch first."
        ),
        parameters={
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
            "additionalProperties": False,
        },
    )
    FETCH = llm.Tool(
        name="web_fetch",
        description="Open a page from your search results and return its text. Only URLs returned by web_search work.",
        parameters={
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
            "additionalProperties": False,
        },
    )

    def __init__(self, day: str, client: TavilyClient, usage: StepUsage, max_searches: int, max_fetches: int):
        d = date.fromisoformat(day)
        self.window = ((d - timedelta(days=1)).isoformat(), (d + timedelta(days=2)).isoformat())
        self.client = client
        self.usage = usage
        self.max_searches = max_searches
        self.max_fetches = max_fetches
        self.seen_urls: set[str] = set()
        self.fetched: dict[str, str] = {}  # url -> exactly the text the model read

    @property
    def tools(self) -> list[llm.Tool]:
        return [self.SEARCH, self.FETCH]

    @property
    def handlers(self) -> dict[str, Handler]:
        return {"web_search": self._search, "web_fetch": self._fetch}

    def _search(self, args: dict) -> tuple[str, bool]:
        if self.usage.web_searches >= self.max_searches:
            return "Search limit reached for this run.", True
        self.usage.web_searches += 1
        try:
            hits = self.client.search(str(args.get("query", "")), *self.window)
        except TavilyError as e:
            self.usage.warnings.append(f"web_search failed: {e}")
            return f"web_search failed: {e}", True
        self.seen_urls.update(h["url"] for h in hits)
        return json.dumps([
            {"title": h.get("title"), "url": h["url"], "published_date": h.get("published_date"),
             "snippet": h.get("content")}
            for h in hits
        ], ensure_ascii=False), False

    def _fetch(self, args: dict) -> tuple[str, bool]:
        url = str(args.get("url", ""))
        if url in self.fetched:
            return self.fetched[url], False
        if url not in self.seen_urls:
            return "Only URLs returned by web_search can be opened.", True
        if self.usage.web_fetches >= self.max_fetches:
            return "Page fetch limit reached for this run.", True
        self.usage.web_fetches += 1
        try:
            text = self.client.extract(url)[: config.MAX_PAGE_CHARS]
        except TavilyError as e:
            self.usage.warnings.append(f"web_fetch failed: {e}")
            return f"web_fetch failed: {e}", True
        self.fetched[url] = text
        return text, False
