#!/usr/bin/env python3
"""Build the free community package of GOHA Suno Helper.

    python tools/build_release.py            # -> dist/GOHA-Suno-Helper-<version>/ and .zip

The package holds the extension (without dev/, tests/, tools/), the bridge package (goha_suno),
the installer and the Vietnamese guide. It is checked before zipping: no pairing code or other
secret of this machine, no path of this machine, none of the channel's data folders or modules,
and the packaged bridge must start on its own with exactly the project tools.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"
BRIDGE_PACKAGE = ROOT / "bridge" / "goha_suno"
INSTALLER = ROOT / "installer"
PACKAGE_NAME = "GOHA-Suno-Helper"

EXTENSION_SKIP = {"dev", "tests", "tools", "install.json", "node_modules", "__pycache__"}
# The bridge package, module by module: nothing else that may sit in the folder ships.
BRIDGE_MODULES = (
    "__init__.py", "suno_agent_bridge.py", "suno_bridge_core.py", "suno_clip_status.py", "suno_jobs.py",
    "suno_plugin.py", "suno_projects.py", "suno_stamp.py",
)
COMMUNITY_TOOLS = {
    "suno_status", "suno_check_clips", "suno_jobs", "suno_pause", "suno_resume", "suno_cancel", "suno_requeue",
    "suno_download_songs", "suno_export_32bit", "suno_split_stems", "suno_generate",
}
# The channel's episode modules live in its own repo, behind its plugin (bridge/goha_suno/suno_plugin.py).
CHANNEL_MODULES = {
    "episode_audio.py", "suno_generation.py", "export_download_handoff.py", "validate_suno.py", "validation_types.py",
    "cli_output.py", "suno_bridge_host.py", "goha_episode_plugin.py", "episode_jobs.py",
}
FORBIDDEN_DIRS = {"episodes", "knowledge", "plans", ".git", "__pycache__", "node_modules", "dev", "tests"}
FORBIDDEN_TEXT = (
    re.compile(r"AI PROJECTS", re.IGNORECASE),
    re.compile(r"japanese-historical-bgm-engine", re.IGNORECASE),
    re.compile(r"[A-Za-z]:\\\\?Users\\\\?PC\b"),
    # Any drive path written out, spaces included (D:\Some Folder\file): a code comment once named one.
    re.compile(r"\b[A-Z]:\\(?![\\\"'])[^\\\"'<>\r\n]{1,120}\\"),
)
TEXT_SUFFIXES = {".js", ".mjs", ".json", ".html", ".css", ".py", ".md", ".txt", ".bat", ""}


class PackageError(Exception):
    """The package must not ship as built."""


def version() -> str:
    return json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["version"]


def _machine_secrets() -> list[str]:
    """This machine's pairing codes (file-based and the one in the AI assistant's MCP config). Never printed."""
    secrets = []
    token = Path.home() / ".jr-suno-bridge" / "token"
    if token.exists():
        secrets.append(token.read_text(encoding="utf-8").strip())
    claude = Path.home() / ".claude.json"
    if claude.exists():
        secrets += re.findall(r'"JR_SUNO_PAIRING_CODE"\s*:\s*"([^"]+)"', claude.read_text(encoding="utf-8", errors="ignore"))
    return [value for value in secrets if len(value) >= 16]


def _copy_extension(target: Path) -> None:
    def ignore(folder: str, names: list[str]) -> set[str]:
        return {name for name in names if name in EXTENSION_SKIP} if Path(folder) == EXTENSION else {"__pycache__"} & set(names)

    shutil.copytree(EXTENSION, target, ignore=ignore)


def _copy_bridge(target: Path) -> None:
    package = target / BRIDGE_PACKAGE.name
    package.mkdir(parents=True)
    for name in BRIDGE_MODULES:
        shutil.copy2(BRIDGE_PACKAGE / name, package / name)
    shutil.copy2(ROOT / "bridge" / "requirements.txt", target / "requirements.txt")
    shutil.copy2(INSTALLER / "cai_dat.py", target / "cai_dat.py")


def _copy_docs(target: Path) -> None:
    for name in ("HUONG-DAN.md", "LICENSE"):
        shutil.copy2(ROOT / name, target / name)
    # The repo's README doubles as the package's: drop the parts meant for people browsing the source.
    readme = re.sub(r"<!-- repo-only -->.*?<!-- /repo-only -->\n*", "", (ROOT / "README.md").read_text(encoding="utf-8"), flags=re.S)
    (target / "README.md").write_text(readme, encoding="utf-8")
    # cmd.exe needs CRLF line endings in a .bat file.
    batch = (INSTALLER / "CAI-DAT.bat").read_text(encoding="utf-8").replace("\r\n", "\n").replace("\n", "\r\n")
    (target / "CAI-DAT.bat").write_bytes(batch.encode("utf-8"))


def check_package(folder: Path, secrets: list[str] | None = None) -> list[str]:
    """Everything in the package that must not ship. Empty = clean."""
    secrets = _machine_secrets() if secrets is None else secrets
    problems = []
    for path in sorted(folder.rglob("*")):
        relative = path.relative_to(folder).as_posix()
        if path.is_dir():
            if path.name in FORBIDDEN_DIRS and not relative.startswith("extension/lib"):
                problems.append(f"thư mục không được đóng gói: {relative}")
            continue
        if path.name == "install.json":
            problems.append(f"install.json của máy này: {relative}")
        if path.name in CHANNEL_MODULES:
            problems.append(f"mã riêng của kênh: {relative}")
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        problems += [f"đường dẫn máy chủ kênh trong {relative}" for pattern in FORBIDDEN_TEXT if pattern.search(text)]
        if any(secret in text for secret in secrets):
            problems.append(f"mã ghép cặp của máy này trong {relative}")
    return problems


def smoke_test(folder: Path) -> set[str]:
    """Start the packaged bridge's MCP server in a fresh process (no repo on its path) and list its tools."""
    code = (
        "import asyncio, sys, tempfile; from pathlib import Path\n"
        "import goha_suno.suno_agent_bridge as a\n"
        "from goha_suno.suno_bridge_core import BridgeCore\n"
        "core = BridgeCore(token='t' * 43, now=lambda: '2026-01-01T00:00:00Z', projects_root=Path(tempfile.mkdtemp()))\n"
        "server = a.build_server(a.SocketBridge(core), 0)\n"
        "print(','.join(sorted(t.name for t in asyncio.run(server.list_tools()))))\n"
    )
    # A community install has no plugin: the dev machine's own GOHA_SUNO_PLUGIN must not leak into the check.
    env = {key: value for key, value in os.environ.items() if key not in ("PYTHONPATH", "GOHA_SUNO_PLUGIN")}
    completed = subprocess.run([sys.executable, "-c", code], cwd=folder / "bridge", capture_output=True, text=True,
                               encoding="utf-8", env=env, check=False)
    if completed.returncode != 0:
        raise PackageError(f"cầu nối trong gói không chạy: {completed.stderr[-800:]}")
    return set(completed.stdout.strip().split(","))


def _remove_tree(folder: Path, attempts: int = 6) -> None:
    """Delete an old build. Windows Search / antivirus hold freshly written files for a moment: try again shortly."""
    for attempt in range(attempts):
        try:
            shutil.rmtree(folder)
            return
        except PermissionError:
            time.sleep(0.5 * (attempt + 1))
    # Still held: move it aside so the new build can go ahead; it is swept on a later run.
    aside = folder.with_name(f".trash-{folder.name}-{int(time.time())}")
    try:
        folder.rename(aside)
    except OSError as error:
        raise PackageError(f"không xoá được bản build cũ (đang có chương trình mở nó): {folder}") from error
    for old in folder.parent.glob(".trash-*"):
        shutil.rmtree(old, ignore_errors=True)


def build(out_root: Path | None = None, secrets: list[str] | None = None) -> Path:
    """Build, check and zip the package. Returns the zip path."""
    out_root = out_root or ROOT / "dist"
    name = f"{PACKAGE_NAME}-{version()}"
    folder = out_root / name
    if folder.exists():
        _remove_tree(folder)
    folder.mkdir(parents=True)
    _copy_extension(folder / "extension")
    _copy_bridge(folder / "bridge")
    _copy_docs(folder)
    problems = check_package(folder, secrets)
    if problems:
        raise PackageError("gói chưa sạch:\n  " + "\n  ".join(problems))
    tools = smoke_test(folder)
    if tools != COMMUNITY_TOOLS:
        raise PackageError(f"bộ tool của cầu nối trong gói lệch: thừa {sorted(tools - COMMUNITY_TOOLS)}, thiếu {sorted(COMMUNITY_TOOLS - tools)}")
    archive = shutil.make_archive(str(out_root / name), "zip", root_dir=out_root, base_dir=name)
    return Path(archive)


def main() -> int:
    argparse.ArgumentParser(description="Build the free community package of GOHA Suno Helper.").parse_args()
    try:
        archive = build()
    except PackageError as error:
        print(f"Lỗi: {error}")
        return 1
    size = archive.stat().st_size / 1_048_576
    print(f"Đã đóng gói: {archive} ({size:.1f} MB)")
    print(f"Thư mục: {archive.with_suffix('')}")
    print("Phát hành: gh release create v<phiên bản> <file zip> (xem CLAUDE.md, mục Phát hành).")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
