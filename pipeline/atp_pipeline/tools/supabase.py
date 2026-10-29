"""Supabase Storage and REST, just what PUBLISH needs (https://supabase.com/docs/guides/api).

Uses the service role key, so it bypasses row-level security. Never ship it to
the browser.
"""

import time

import httpx

from .. import config

RETRY_STATUS = {429, 500, 502, 503, 504}
MAX_TRIES = 4


class SupabaseError(RuntimeError):
    pass


class SupabaseClient:
    def __init__(self, url: str | None = None, key: str | None = None):
        self.url = (url or config.require("SUPABASE_URL")).rstrip("/")
        key = key or config.require("SUPABASE_SERVICE_ROLE_KEY")
        self._http = httpx.Client(base_url=self.url, headers={"apikey": key, "Authorization": f"Bearer {key}"},
                                  timeout=120)

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        for attempt in range(MAX_TRIES):
            res = self._http.request(method, path, **kwargs)
            if res.is_success:
                return res
            if res.status_code not in RETRY_STATUS or attempt == MAX_TRIES - 1:
                raise SupabaseError(f"{method} {path} -> HTTP {res.status_code}: {res.text[:300]}")
            time.sleep(2 ** attempt)
        raise AssertionError("unreachable")

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> str:
        """Upload (or overwrite) a file in a public bucket; returns its public URL."""
        self._request("POST", f"/storage/v1/object/{bucket}/{path}", content=data,
                      headers={"Content-Type": content_type, "x-upsert": "true"})
        return f"{self.url}/storage/v1/object/public/{bucket}/{path}"

    def upsert(self, table: str, row: dict, on_conflict: str) -> None:
        self._request("POST", f"/rest/v1/{table}", params={"on_conflict": on_conflict}, json=row,
                      headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
