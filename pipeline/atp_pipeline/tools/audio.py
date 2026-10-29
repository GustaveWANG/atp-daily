"""ffmpeg / ffprobe helpers: real durations, silence detection, stitching."""

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .. import config

_SILENCE = re.compile(r"silence_(start|end): (-?[\d.]+)")


def _check_tools() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise RuntimeError(f"{tool} not found; install ffmpeg (brew install ffmpeg)")


def duration(path: Path) -> float:
    _check_tools()
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def interior_silences(path: Path, total: float) -> list[tuple[float, float]]:
    """(start, length) of silences longer than QA_MAX_SILENCE, not counting the clip's edges."""
    _check_tools()
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
         f"silencedetect=noise={config.QA_SILENCE_DB}dB:d={config.QA_MAX_SILENCE}", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    events = [(kind, float(t)) for kind, t in _SILENCE.findall(out.stderr)]
    silences, start = [], None
    for kind, t in events:
        if kind == "start":
            start = t
        elif start is not None:
            silences.append((start, t - start))
            start = None
    edge = 0.05
    return [(s, n) for s, n in silences if s > edge and s + n < total - edge]


def stitch(clips: list[Path], gaps: list[float], out: Path) -> None:
    """Join clips with gaps[i] seconds of silence before clip i, normalise loudness, encode MP3."""
    _check_tools()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        rate = config.AUDIO_SAMPLE_RATE
        parts = []
        for i, (clip, gap) in enumerate(zip(clips, gaps)):
            if gap > 0:
                silence = tmp / f"gap_{i:03d}.wav"
                subprocess.run(
                    ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"anullsrc=r={rate}:cl=mono",
                     "-t", f"{gap:.3f}", str(silence)],
                    check=True,
                )
                parts.append(silence)
            wav = tmp / f"line_{i:03d}.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-i", str(clip), "-ar", str(rate), "-ac", "1", str(wav)], check=True)
            parts.append(wav)

        listing = tmp / "concat.txt"
        listing.write_text("".join(f"file '{p}'\n" for p in parts))
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
             "-af", f"loudnorm=I={config.AUDIO_LOUDNESS_LUFS}:TP=-1.5:LRA=11", "-ar", str(rate),
             "-c:a", "libmp3lame", "-b:a", config.AUDIO_BITRATE, str(out)],
            check=True,
        )
