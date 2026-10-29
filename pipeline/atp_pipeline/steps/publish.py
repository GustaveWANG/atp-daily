"""Step 7 - PUBLISH.

Pure code, no model calls: upload the episode MP3 to Supabase Storage and
upsert the day's row in `episodes`, which is what the website reads.
Re-publishing a date overwrites that day's audio and row.
"""

from pathlib import Path

from .. import config
from ..schemas import ProduceOutput, ReviewOutput
from ..tools.supabase import SupabaseClient
from .produce import script_hash


class PublishError(RuntimeError):
    pass


def run(review: ReviewOutput, produced: ProduceOutput, run_dir: Path) -> dict:
    """Returns the row written to `episodes`."""
    draft = review.draft
    if produced.script_hash != script_hash(draft.script):
        raise PublishError("the audio was made from a different script; rerun produce")
    if produced.status != "passed" and not config.PUBLISH_NEEDS_REVIEW:
        raise PublishError("some lines still fail audio QA (status needs_review); "
                           "listen and set PUBLISH_NEEDS_REVIEW=1 to publish anyway")

    client = SupabaseClient()
    day = review.target_date
    url = client.upload(config.PUBLISH_BUCKET, f"episodes/{day}.mp3",
                        (run_dir / produced.audio_file).read_bytes(), "audio/mpeg")
    row = {
        "date": day,
        "title": draft.meta.title,
        "headline": draft.meta.headline,
        "the_read": draft.meta.the_read,
        "bracket_watch": draft.meta.bracket_watch,
        "chapter_titles": draft.chapter_titles,
        "script": "\n".join(f"{line.speaker}: {line.text}" for line in draft.script),
        # The object path is the same every time a day is re-published; the
        # hash makes browsers and the CDN fetch the new file.
        "audio_url": f"{url}?v={produced.script_hash}",
        "audio_duration": round(produced.duration),
    }
    client.upsert("episodes", row, on_conflict="date")
    return row
