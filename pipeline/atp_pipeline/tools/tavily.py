"""Tavily web search and page extraction (https://docs.tavily.com).

Responses are cached under data/cache/tavily/, keyed by the request body, so
re-running a day during development costs no credits.
"""

import hashlib
import json

import httpx

from .. import config

BASE_URL = "https://api.tavily.com"
CACHE_DIR = config.CACHE_DIR / "tavily"


class TavilyError(RuntimeError):
    pass


class TavilyClient:
    def __init__(self, api_key: str | None = None, use_cache: bool = True):
        self.api_key = api_key or config.require("TAVILY_API_KEY")
        self.use_cache = use_cache
        self.requests = 0
        self.cache_hits = 0
        self.credits = 0.0
        self._http = httpx.Client(
            base_url=BASE_URL,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=60,
        )

    def _post(self, path: str, body: dict) -> dict:
        key = hashlib.sha1(json.dumps([path, body], sort_keys=True).encode()).hexdigest()[:16]
        cache_file = CACHE_DIR / f"{path.strip('/')}_{key}.json"
        if self.use_cache and cache_file.exists():
            self.cache_hits += 1
            return json.loads(cache_file.read_text())

        self.requests += 1
        res = self._http.post(path, json=body)
        if res.status_code != 200:
            raise TavilyError(f"POST {path} -> HTTP {res.status_code}: {res.text[:300]}")
        data = res.json()
        self.credits += (data.get("usage") or {}).get("credits") or 0

        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        return data

    def search(self, query: str, start_date: str, end_date: str) -> list[dict]:
        """Ranked results: title, url, content (snippet), published_date, score."""
        data = self._post("/search", {
            "query": query,
            "search_depth": config.TAVILY_SEARCH_DEPTH,
            "topic": "general",
            "max_results": config.TAVILY_MAX_RESULTS,
            "start_date": start_date,
            "end_date": end_date,
            "include_published_date": True,
            "exclude_domains": config.TAVILY_EXCLUDE_DOMAINS,
            "include_usage": True,
        })
        return data.get("results", [])

    def extract(self, url: str) -> str:
        """Plain-text body of one page."""
        data = self._post("/extract", {
            "urls": [url],
            "extract_depth": "basic",
            "format": "text",
            "include_usage": True,
        })
        for result in data.get("results", []):
            if result.get("raw_content"):
                return result["raw_content"]
        failed = data.get("failed_results") or [{}]
        raise TavilyError(f"could not extract {url}: {failed[0].get('error', 'no content')}")
