"""Last step of CAI-DAT.bat: tell the extension where this machine's bridge and Python are, then check the bridge loads.

Writes `extension/install.json` ({bridgePath, python}). The side panel reads it to fill the MCP
config the user copies into their AI assistant, so nobody has to type a path.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
BRIDGE = PACKAGE / "bridge" / "goha_suno" / "suno_agent_bridge.py"
EXTENSION = PACKAGE / "extension"


def main() -> int:
    if not BRIDGE.exists() or not (EXTENSION / "manifest.json").exists():
        print("  [!] Thiếu thư mục bridge/ hoặc extension/ — giải nén lại đủ cả gói rồi chạy CAI-DAT.bat.")
        return 1
    sys.path.insert(0, str(PACKAGE / "bridge"))
    try:
        import mcp.server  # noqa: F401
        import websockets  # noqa: F401

        import goha_suno.suno_agent_bridge  # noqa: F401
    except ImportError as error:
        print(f"  [!] Cầu nối chưa chạy được: {error}. Chạy lại CAI-DAT.bat.")
        return 1
    info = {"bridgePath": str(BRIDGE), "python": sys.executable}
    (EXTENSION / "install.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print()
    print("  Xong! Còn 3 bước trong Chrome (xem HUONG-DAN.md):")
    print("   1. Mở chrome://extensions, bật 'Chế độ dành cho nhà phát triển' (Developer mode).")
    print("   2. Bấm 'Tải tiện ích đã giải nén' (Load unpacked) và chọn thư mục:")
    print(f"      {EXTENSION}")
    print("   3. Bấm biểu tượng GOHA Suno Helper > tab Cài đặt > 'Copy cấu hình MCP',")
    print("      dán vào trợ lý AI (Claude Code / Codex / Antigravity) và nói: cài MCP này giúp tôi.")
    print()
    print("  Đừng di chuyển thư mục này sau khi cài; nếu chuyển, chạy lại CAI-DAT.bat.")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
