"""How to spell names so the TTS voice says them right.

The script keeps the real spelling (the QA transcript is compared against it);
only the text sent to TTS is rewritten. Add a name when a listen-through or the
QA step shows it being misread. Matching is whole-word and case-sensitive.
"""

import re

ALIASES: dict[str, str] = {
    "Lehecka": "Leh-hetska",
}

_PATTERN = re.compile(r"\b(" + "|".join(map(re.escape, sorted(ALIASES, key=len, reverse=True))) + r")\b") if ALIASES else None


def spoken(text: str) -> str:
    return _PATTERN.sub(lambda m: ALIASES[m.group(1)], text) if _PATTERN else text
