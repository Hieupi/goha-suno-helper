"""Print Vietnamese operator text without the console eating it.

Every operator-facing script in this repository writes Vietnamese, and the
default Windows console encoding (cp1252) cannot represent it: `print()` raises
UnicodeEncodeError and the command dies halfway through its output. Each CLI
calls `ensure_utf8_stdout()` once at startup.
"""

from __future__ import annotations

import sys

ENCODING = "utf-8"


def _needs_reconfigure(stream) -> bool:
    """True when the stream declares an encoding that is not UTF-8.

    An in-memory stream reports no encoding at all and needs nothing done to it.
    """
    encoding = (getattr(stream, "encoding", None) or "").lower().replace("-", "")
    return bool(encoding) and encoding != "utf8"


def ensure_utf8_stdout() -> None:
    """Switch stdout and stderr to UTF-8 when the console would mangle them."""
    for stream in (sys.stdout, sys.stderr):
        if _needs_reconfigure(stream):
            try:
                stream.reconfigure(encoding=ENCODING)
            except (AttributeError, OSError):
                pass  # a stream that cannot be reconfigured; write_stdout degrades instead


def write_stdout(text: str) -> None:
    """Write a generated document to stdout, whatever the console can take."""
    stream = sys.stdout
    if _needs_reconfigure(stream):
        try:
            stream.reconfigure(encoding=ENCODING)
        except (AttributeError, OSError):
            encoding = (getattr(stream, "encoding", None) or ENCODING)
            text = text.encode(encoding, "replace").decode(encoding, "replace")
    stream.write(text)
