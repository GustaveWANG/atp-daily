"""ElevenLabs text-to-speech and speech-to-text (https://elevenlabs.io/docs).

Audio and transcripts are cached under data/cache/elevenlabs/, keyed by the
request, so re-running a day costs nothing for lines that did not change.
"""

import hashlib
import json
import time

import httpx

from .. import config

BASE_URL = "https://api.elevenlabs.io"
CACHE_DIR = config.CACHE_DIR / "elevenlabs"
RETRY_STATUS = {429, 500, 502, 503, 504}
MAX_TRIES = 5

# Models that accept previous_text / next_text for smoother delivery.
CONTEXT_MODELS = {"eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_flash_v2"}


class ElevenLabsError(RuntimeError):
    pass


class ElevenLabsClient:
    def __init__(self, api_key: str | None = None, use_cache: bool = True):
        self.api_key = api_key or config.require("ELEVENLABS_API_KEY")
        self.use_cache = use_cache
        self.tts_requests = 0
        self.stt_requests = 0
        self.cache_hits = 0
        self.characters = 0  # billed TTS characters (cache hits excluded)
        self.stt_seconds = 0.0
        self._http = httpx.Client(base_url=BASE_URL, headers={"xi-api-key": self.api_key}, timeout=180)

    def _request(self, path: str, **kwargs) -> httpx.Response:
        for attempt in range(MAX_TRIES):
            res = self._http.post(path, **kwargs)
            if res.status_code == 200:
                return res
            if res.status_code not in RETRY_STATUS or attempt == MAX_TRIES - 1:
                raise ElevenLabsError(f"POST {path} -> HTTP {res.status_code}: {res.text[:300]}")
            time.sleep(2 ** attempt + float(res.headers.get("retry-after", 0) or 0))
        raise AssertionError("unreachable")

    def tts(self, text: str, voice_id: str, *, seed: int, previous_text: str | None = None,
            next_text: str | None = None) -> bytes:
        """MP3 of one line, spoken by one voice."""
        body = {
            "text": text,
            "model_id": config.TTS_MODEL,
            "voice_settings": config.TTS_VOICE_SETTINGS,
            "seed": seed,
        }
        if config.TTS_MODEL in CONTEXT_MODELS:
            if previous_text:
                body["previous_text"] = previous_text
            if next_text:
                body["next_text"] = next_text
        path = f"/v1/text-to-speech/{voice_id}"
        params = {"output_format": config.TTS_OUTPUT_FORMAT}
        key = hashlib.sha1(json.dumps([path, params, body], sort_keys=True).encode()).hexdigest()[:16]
        cache_file = CACHE_DIR / f"tts_{key}.mp3"
        if self.use_cache and cache_file.exists():
            self.cache_hits += 1
            return cache_file.read_bytes()

        self.tts_requests += 1
        audio = self._request(path, params=params, json=body).content
        self.characters += len(text)
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_bytes(audio)
        return audio

    def stt(self, audio: bytes, duration: float) -> str:
        """Transcript of an English clip."""
        key = hashlib.sha1(audio + config.STT_MODEL.encode()).hexdigest()[:16]
        cache_file = CACHE_DIR / f"stt_{key}.json"
        if self.use_cache and cache_file.exists():
            self.cache_hits += 1
            return json.loads(cache_file.read_text())["text"]

        self.stt_requests += 1
        res = self._request(
            "/v1/speech-to-text",
            data={"model_id": config.STT_MODEL, "language_code": "en", "tag_audio_events": "false"},
            files={"file": ("line.mp3", audio, "audio/mpeg")},
        )
        data = res.json()
        self.stt_seconds += duration
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        return data.get("text", "")
