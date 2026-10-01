"""Shared types for the repository validators.

Findings carry one of three severities (see knowledge/26_STATUS_TAXONOMY.md):

    ERROR           broken contract or documented hard limit -> blocks CI
    WARNING_STRONG  legal, but likely to damage output quality
    WARNING         deviation from a recommended operating range

Only ERROR blocks by default. A recommended range must never produce an ERROR.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator, NamedTuple

ERROR = "ERROR"
WARNING_STRONG = "WARNING_STRONG"
WARNING = "WARNING"
SEVERITY_ORDER = (ERROR, WARNING_STRONG, WARNING)


class Finding(NamedTuple):
    severity: str
    message: str


# Directories that never contain project knowledge.
SKIP_DIR_PARTS = {".git", ".worktrees", "worktrees", ".venv", "node_modules", "artifacts"}


def iter_yaml_files(root: Path) -> Iterator[Path]:
    """Yield every project YAML file, skipping build and environment directories."""
    for path in sorted(root.rglob("*.yaml")):
        if SKIP_DIR_PARTS.intersection(path.parts):
            continue
        yield path
