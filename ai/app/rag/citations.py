from __future__ import annotations

import re

_MARKER = re.compile(r"\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]")


def markers_in(text: str) -> list[int]:
    """Every source number the answer cites, in order of first use. Numbers only: no source is implied by wording."""
    seen: list[int] = []
    for m in _MARKER.finditer(text):
        for part in m.group(1).split(","):
            n = int(part)
            if n not in seen:
                seen.append(n)
    return seen
