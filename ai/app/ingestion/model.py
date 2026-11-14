from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Block:
    """The smallest unit the chunker will not split unless it must (a paragraph, table row, slide, ...)."""

    text: str
    loc: dict = field(default_factory=dict)  # page | slide | sheet | rowStart/rowEnd | charStart/charEnd | headingPath
    hard: object = None  # a change here ALWAYS starts a new chunk (e.g. another worksheet)
    soft: object = None  # a change here starts a new chunk once the current one is big enough (headings, slides)
    context: str = ""  # repeated at the top of every chunk of this section (sheet name + column headers)
    sep: str = "\n\n"  # separator placed before this block when it joins others


@dataclass
class Extraction:
    format: str
    blocks: list[Block]
    stats: dict = field(default_factory=dict)
