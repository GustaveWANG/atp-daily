"""Step 6 - PRODUCE.

Pure code, no model calls:
1. TTS each script line with its host's voice (limited concurrency). Names are
   respelled for the voice first (pronunciations.py).
2. QA each line: speech-to-text it and compare with the script, check the
   speaking rate and look for long silences. A failing line is re-rolled with a
   new seed, up to TTS_MAX_ATTEMPTS; the best take is kept.
3. Stitch the lines with short gaps, normalise loudness, read the real duration.

The episode is always stitched so a person can listen to it, but any line
still failing QA makes the status needs_review.
"""

import difflib
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .. import config
from ..pronunciations import spoken
from ..schemas import AudioLine, AudioUsage, ProduceOutput, ReviewOutput, ScriptLine
from ..tools import audio
from ..tools.elevenlabs import ElevenLabsClient


def script_hash(lines: list[ScriptLine]) -> str:
    data = json.dumps([[line.speaker, line.text] for line in lines], ensure_ascii=False)
    return hashlib.sha256(data.encode()).hexdigest()[:16]


def run(review: ReviewOutput, out_dir: Path) -> ProduceOutput:
    """out_dir is the run's audio/ dir; line clips and episode.mp3 go there."""
    script = review.draft.script
    client = ElevenLabsClient()
    (out_dir / "lines").mkdir(parents=True, exist_ok=True)

    def produce(i: int) -> AudioLine:
        return _produce_line(client, script, i, out_dir)

    with ThreadPoolExecutor(config.TTS_CONCURRENCY) as pool:
        lines = list(pool.map(produce, range(len(script))))

    episode = out_dir / "episode.mp3"
    audio.stitch([out_dir / line.file for line in lines], _gaps(script), episode)

    return ProduceOutput(
        target_date=review.target_date,
        status="passed" if all(not line.issues for line in lines) else "needs_review",
        script_hash=script_hash(script),
        audio_file=f"{out_dir.name}/{episode.name}",
        duration=round(audio.duration(episode), 2),
        tts_model=config.TTS_MODEL,
        voices=config.TTS_VOICES,
        lines=lines,
        usage=AudioUsage(
            tts_requests=client.tts_requests,
            tts_characters=client.characters,
            stt_requests=client.stt_requests,
            stt_seconds=round(client.stt_seconds, 1),
            cache_hits=client.cache_hits,
        ),
    )


def _produce_line(client: ElevenLabsClient, script: list[ScriptLine], i: int, out_dir: Path) -> AudioLine:
    line = script[i]
    prev_text = spoken(script[i - 1].text) if i > 0 else None
    next_text = spoken(script[i + 1].text) if i + 1 < len(script) else None
    rel = f"lines/{i + 1:03d}.mp3"

    best, best_audio = None, None
    for attempt in range(1, config.TTS_MAX_ATTEMPTS + 1):
        clip = client.tts(spoken(line.text), config.TTS_VOICES[line.speaker], seed=attempt,
                          previous_text=prev_text, next_text=next_text)
        path = out_dir / rel
        path.write_bytes(clip)
        seconds = audio.duration(path)
        transcript = client.stt(clip, seconds)
        # STT may write a respelled name either way.
        similarity = max(text_similarity(line.text, transcript), text_similarity(spoken(line.text), transcript))
        result = AudioLine(
            index=i + 1, speaker=line.speaker, file=rel, duration=round(seconds, 2),
            transcript=transcript, similarity=round(similarity, 3), attempts=attempt,
            issues=check_line(line.text, similarity, seconds, audio.interior_silences(path, seconds)),
        )
        if best is None or (len(result.issues), -result.similarity) < (len(best.issues), -best.similarity):
            best, best_audio = result, clip
        if not result.issues:
            break

    best.attempts = attempt
    (out_dir / rel).write_bytes(best_audio)
    return best


def check_line(text: str, similarity: float, seconds: float, silences: list[tuple[float, float]]) -> list[str]:
    issues = []
    if similarity < config.QA_MIN_SIMILARITY:
        issues.append(f"transcript matches the script only {similarity:.0%}")
    words = len(_words(text))
    if words >= 4 and seconds > 0:
        rate = words / seconds
        if rate < config.QA_MIN_WORDS_PER_SEC:
            issues.append(f"too slow: {rate:.1f} words/s")
        elif rate > config.QA_MAX_WORDS_PER_SEC:
            issues.append(f"too fast: {rate:.1f} words/s")
    for start, length in silences:
        issues.append(f"{length:.1f}s of silence at {start:.1f}s")
    return issues


def _gaps(script: list[ScriptLine]) -> list[float]:
    gaps = [0.0]
    for prev, line in zip(script, script[1:]):
        gaps.append(config.SEGMENT_GAP if line.segment != prev.segment else config.LINE_GAP)
    return gaps


# ------------------------------------------------------- transcript matching
# The script spells numbers out ("seven-five", "twenty twenty-six"); STT often
# writes digits ("7-5", "2026"). Digits are spelled out before comparing, and a
# four-digit number is tried both as a year and as a plain number.

_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_ORDINALS = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
             "nine": "ninth", "twelve": "twelfth"}


def _cardinal(n: int) -> str:
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if n < 1000:
        return _ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + _cardinal(n % 100))
    if n < 1_000_000:
        return _cardinal(n // 1000) + " thousand" + ("" if n % 1000 == 0 else " " + _cardinal(n % 1000))
    return str(n)


def _year(n: int) -> str:
    hi, lo = divmod(n, 100)
    if n % 1000 < 10 and n >= 2000:  # 2000-2009: "two thousand five"
        return _cardinal(n)
    return _cardinal(hi) + (" hundred" if lo == 0 else " " + ("oh " if lo < 10 else "") + _cardinal(lo))


def _ordinal(words: str) -> str:
    head, _, last = words.rpartition(" ")
    if last in _ORDINALS:
        last = _ORDINALS[last]
    elif last.endswith("y"):
        last = last[:-1] + "ieth"
    else:
        last += "th"
    return f"{head} {last}".strip()


def _spell_numbers(text: str, years: bool) -> str:
    def number(m: re.Match) -> str:
        digits, suffix = m.group(1).replace(",", ""), m.group(2)
        n = int(digits)
        words = _year(n) if years and len(digits) == 4 and 1100 <= n <= 2099 else _cardinal(n)
        if suffix:
            words = _ordinal(words)
        return f" {words} "

    text = re.sub(r"(\d+)\s*%", r"\1 percent", text)
    return re.sub(r"(\d[\d,]*)(st|nd|rd|th)?\b", number, text)


def _words(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9' ]+", " ", text.lower().replace("-", " ")).replace("'", "").split()


def text_similarity(script_text: str, transcript: str) -> float:
    target = _words(_spell_numbers(script_text, years=True))
    return max(
        difflib.SequenceMatcher(None, target, _words(_spell_numbers(transcript, years=years)), autojunk=False).ratio()
        for years in (True, False)
    )
