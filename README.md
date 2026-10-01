# GOHA Suno Helper

**Trợ lý AI làm việc trên Suno thay bạn — tặng miễn phí cho cộng đồng.**

Bạn nói với trợ lý AI của mình (Claude Code, Codex, Antigravity…), GOHA Suno Helper bấm Suno ngay trong Chrome của bạn:

- 🎧 **Tải WAV** hàng loạt theo link bài, không trừ lượt tải hằng tháng
- 💎 **Xuất 32-bit float** (48 kHz) để mix/master trên DAW
- 🎛️ **Tách stem** (Auto split) và tải bản trộn + từng nhạc cụ ở 32-bit
- ✨ **Tạo nhạc** theo mô tả, điền form Create giúp bạn
- 🛡️ An toàn credit: việc tốn credit phải có xác nhận của bạn; bài đã tách không bị tách lại; mất kết nối giữa lúc tạo/tách thì dừng chờ bạn, không tự chạy lại

## Cài đặt nhanh

1. Tải bản mới nhất ở mục **Releases** hoặc [Google Drive](https://drive.google.com/drive/folders/1B1P6N31hwHpsXf9rft6C5vbH_WaaoVYf?usp=drive_link), giải nén vào một thư mục cố định.
2. Chạy `CAI-DAT.bat`.
3. Chrome → `chrome://extensions` → bật Chế độ dành cho nhà phát triển → **Tải tiện ích đã giải nén** → chọn thư mục `extension`.
4. Mở bảng bên GOHA Suno Helper → **Cài đặt** → **Copy cấu hình MCP** → dán vào trợ lý AI: *"cài MCP này giúp tôi"*.

Chi tiết từng bước, câu mẫu giao việc, xử lý sự cố: **[HUONG-DAN.md](HUONG-DAN.md)**.

Cần: Windows, Chrome 116+, Python 3.10+, gói Suno **Premier** cho các việc dùng Studio (tải WAV, 32-bit, tách stem).

<!-- repo-only -->
> Repo này là **mã nguồn**. Người dùng tải **gói đã đóng sẵn** (file `.zip`) ở mục Releases hoặc Google Drive —
> đừng chạy thẳng từ bản clone.
<!-- /repo-only -->

## ⭐ Nếu thấy hữu ích

Tặng repo **1 sao** để mình có thêm động lực làm tiếp, và chia sẻ cho bạn bè cùng làm nhạc với Suno.

## Cộng đồng & liên hệ

- YouTube: [Nông Dân AI](https://www.youtube.com/@NongDanAI99)
- Group Facebook: [Nông Dân Học AI Kiếm Tiền](https://www.facebook.com/share/g/1Lbczu1WqB/)
- Website: [nguyenhieuai.com](https://nguyenhieuai.com/)
- Mời mình 1 ly cafe: QR Vietinbank có trong tab **Giới thiệu** của extension (STK 60048899 · NGUYEN VAN HIEU)

## Lưu ý

Không liên kết với Suno, Inc. Extension chỉ bấm những nút bạn vẫn tự bấm, theo tốc độ người dùng, dừng khi Suno
hỏi xác nhận, và không vượt hạn mức tài khoản của bạn. Bạn tự chịu trách nhiệm tuân thủ điều khoản của Suno.

<!-- repo-only -->
## Phát triển

```
extension/          Chrome extension (MV3) — test: cd extension && node --test tests/*.test.mjs
bridge/goha_suno/   cầu nối Python (MCP) — test: python -m unittest discover -s bridge/tests -t bridge
                    thêm việc/tool riêng của bạn: biến GOHA_SUNO_PLUGIN (xem bridge/goha_suno/suno_plugin.py)
installer/          CAI-DAT.bat + cai_dat.py
tools/build_release.py   đóng gói dist/GOHA-Suno-Helper-<phiên bản>.zip (tự kiểm bí mật, đường dẫn, chạy thử cầu nối)
```

Báo lỗi, góp ý: mục Issues hoặc Group Facebook ở trên. Pull request luôn được chào đón.
<!-- /repo-only -->

## Giấy phép

[MIT](LICENSE) © 2026 Nguyễn Hiếu AI
