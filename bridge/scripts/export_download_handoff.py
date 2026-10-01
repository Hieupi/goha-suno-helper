#!/usr/bin/env python3
"""Compile an episode's missing takes into a DOWNLOAD-JOB block for a fresh chat.

Exporting a take from Suno Studio is twenty clicks of no judgement, repeated
thirty-six times. Driving that from a session that is also holding the episode's
whole context spends it on "click the next button", which is the same waste the
visual phase already moved out (see scripts/export_visual_handoff.py).

This builds the block from the same records the worklist reads, so the episode's
own data stays the single source of truth and no URL is ever retyped.

    python scripts/export_download_handoff.py EP003
    python scripts/export_download_handoff.py EP003 \\
        --download-dir "episodes/EP003-autumn-wind-tokaido-journey/Download" --write
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.cli_output import ensure_utf8_stdout, write_stdout  # noqa: E402
from scripts.episode_audio import (  # noqa: E402
    ENCODING,
    TAKES_PER_SLOT,
    TRUNCATED_BELOW,
    Candidate,
    find_episode_dir,
    iter_takes,
    load_candidates,
    load_slot_targets,
    load_slot_titles,
    missing_takes,
    rejected_song_ids,
    take_filename,
    taken_song_ids,
)

HANDOFF_SUFFIX = "-download-handoff.md"


def choose_candidates(
    episode_dir: Path,
) -> tuple[dict[int, list[Candidate]], dict[int, int]]:
    """Cho mỗi slot còn thiếu: những ứng viên đáng tải, và cần bao nhiêu take.

    Bỏ ứng viên đã có trên máy, đã nằm trong `rejected-takes/`, và ứng viên
    render cụt — cùng ba luật worklist dùng, để hai tài liệu không lệch nhau.
    """
    titles = load_slot_titles(episode_dir)
    targets = load_slot_targets(episode_dir)
    takes = list(iter_takes(episode_dir))
    taken = taken_song_ids(episode_dir, takes)
    rejected = rejected_song_ids(episode_dir)
    needed = {s: n for s, n in missing_takes(takes, sorted(titles)).items() if n}

    usable: dict[int, list[Candidate]] = {}
    for candidate in load_candidates(episode_dir):
        if candidate.slot not in needed:
            continue
        if candidate.song_id in taken or candidate.song_id in rejected:
            continue
        target = targets.get(candidate.slot)
        if (
            target
            and candidate.duration_actual is not None
            and candidate.duration_actual < target * TRUNCATED_BELOW
        ):
            continue
        usable.setdefault(candidate.slot, []).append(candidate)
    return usable, needed


def render_handoff(episode_dir: Path, download_dir: str = "<thư mục tải về>") -> str:
    """Khối DOWNLOAD-JOB dán vào một phiên chat mới có trình duyệt."""
    episode_id = episode_dir.name
    short = episode_id.split("-")[0]
    titles = load_slot_titles(episode_dir)
    usable, needed = choose_candidates(episode_dir)

    lines = [
        f"# Bàn giao tải nhạc — {episode_id}",
        "",
        "<!-- Sinh tự động bởi scripts/export_download_handoff.py. Đừng sửa tay. -->",
        "",
    ]
    if not needed:
        lines += ["Mọi slot đã đủ take. Không có gì để bàn giao.", ""]
        return "\n".join(lines)

    lines += [
        f"Dán toàn bộ phần dưới vào phiên chat mới (cần có trình duyệt). "
        f"Cần **{sum(needed.values())} file**.",
        "",
        "---",
        "",
        "## DOWNLOAD-JOB",
        "",
        f"Bạn đang tải nhạc cho tập **{episode_id}** từ tài khoản Suno của tôi "
        "(trình duyệt phải đã đăng nhập sẵn — thanh bên không được hiện chữ \"Log in\").",
        "",
        "### Luật",
        "",
        "1. **Luôn đi đường Studio export**, không bấm Download thẳng ở trang bài. "
        "Hạn mức tải tháng đã cạn; Studio export miễn hạn mức.",
        f"2. **Tải về đúng thư mục** `{download_dir}` — trỏ sẵn thư mục tải của "
        "trình duyệt vào đó trước khi bắt đầu.",
        "3. **Chỉ WAV** (D035). Trong hộp Download bỏ chọn MP3. "
        "Ingest từ chối mọi file không phải `.wav`.",
        "4. **Không đổi tên file.** Tên do script cấp sau.",
        "5. Mỗi slot lấy đúng số take ghi bên dưới, chọn từ trên xuống.",
        "6. Nếu một bài không đủ thời lượng (xem cột *Dài*), **bỏ qua và báo lại** — "
        "đừng tải rồi mới nói.",
        "",
        "### Làm với từng link",
        "",
        "1. Mở link.",
        "2. `···` → rê chuột vào **Edit** → **Open in Studio** → **Single-track**. "
        "(Multi-track tốn 50 credit, không dùng.)",
        "3. Đợi waveform hiện kín timeline — thường 30-50 giây. "
        "**Export sớm sẽ ra file cụt.**",
        "4. **Export → Full Song** → chờ hộp xanh \"Song Saved!\" → bấm **Go to Song**.",
        "5. Ở tab mới, đợi khoảng 30 giây cho bài xử lý xong "
        "(chưa xong thì mục Download còn mờ — nạp lại trang rồi thử lại).",
        "6. `···` → **Download** → **bỏ chọn MP3, chỉ để WAV** → Download.",
        "   Hộp thoại ghi \"You've unlocked this song\" nghĩa là không trừ hạn mức.",
        "",
        "### Bẫy đã gặp",
        "",
        "- Submenu **Edit** không mở nếu chỉ rê chuột một nhát — rê qua vài mục "
        "trong menu rồi mới dừng ở Edit.",
        "- Cú bấm **Export** đầu tiên sau khi Studio vừa nạp xong hay bị nuốt. "
        "Bấm rồi nhìn xem menu đã mở chưa, mới bấm tiếp.",
        "- Đừng bấm liên tiếp khi hộp thoại chưa chắc đã mở: cú bấm lạc rơi xuống "
        "trang và có thể bấm nhầm nút **Dislike**.",
        "",
        "### Danh sách",
        "",
    ]

    for slot in sorted(needed):
        count = needed[slot]
        options = usable.get(slot, [])
        pattern = take_filename(episode_id, slot, 0, titles[slot]).replace(".0. ", ".<take>. ")
        lines.append(f"**Slot {slot:02d} — {titles[slot]} — lấy {count} bài**")
        lines.append("")
        if not options:
            lines.append("> ⚠ Không còn ứng viên nào. Báo lại, đừng tự tìm bài khác.")
            lines.append("")
            continue
        for candidate in options:
            duration = (
                f" · {candidate.duration_actual} s"
                if candidate.duration_actual is not None
                else ""
            )
            lines.append(f"- {candidate.url}{duration}")
        if len(options) < count:
            lines.append("")
            lines.append(
                f"> ⚠ Chỉ còn {len(options)} ứng viên cho {count} take cần. Báo lại."
            )
        lines.append("")
        lines.append(f"<sub>file sẽ thành `{pattern}` — đừng tự đặt</sub>")
        lines.append("")

    lines += [
        "### Xong thì báo",
        "",
        f"Liệt kê mỗi slot đã tải mấy file, và **song id của bản export** "
        "(nằm trong URL tab mở ra sau khi bấm Go to Song — id này khác id trong link trên).",
        "",
        "---",
        "",
        "## Sau khi tải xong",
        "",
        "```bash",
        f"python scripts/ingest_suno_downloads.py {short} --source \"{download_dir}\"",
        f"python scripts/export_download_worklist.py {short}",
        "```",
        "",
        f"Ingest đọc id nhúng trong file, cấp số take, đặt tên đúng D034 "
        f"({TAKES_PER_SLOT} take/slot), chặn trùng và chặn file cụt. "
        "Worklist phải ra \"Không thiếu gì\".",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("episode", help="Tên tập hoặc tiền tố, ví dụ EP003")
    parser.add_argument(
        "--download-dir",
        default="<thư mục tải về>",
        help="Thư mục trình duyệt tải về, đưa thẳng vào lệnh ingest",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Ghi <ep>-download-handoff.md vào thư mục tập",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Thư mục gốc repo (mặc định: tự dò)",
    )
    args = parser.parse_args()
    ensure_utf8_stdout()

    try:
        episode_dir = find_episode_dir(args.root.resolve(), args.episode)
    except (FileNotFoundError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    document = render_handoff(episode_dir, args.download_dir)
    if not args.write:
        write_stdout(document)
        return 0

    target = episode_dir / f"{episode_dir.name.split('-')[0].lower()}{HANDOFF_SUFFIX}"
    target.write_text(document, encoding=ENCODING, newline="\n")
    print(f"wrote {target.relative_to(args.root.resolve())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
