# Hướng dẫn GOHA Suno Helper

GOHA Suno Helper là trợ lý làm việc trên Suno thay bạn, ngay trong Chrome của bạn. Bạn nói với trợ lý AI
(Claude Code, Codex, Antigravity…) bằng tiếng Việt, trợ lý giao việc cho extension, extension bấm Suno giúp bạn:

- **Tải WAV** các bài bạn đưa link, qua tính năng Studio export có sẵn trong gói Premier của bạn.
- **Xuất 32-bit float**: bản trộn 48 kHz / 32-bit, chất lượng cao nhất Suno cho, để mix/master trên DAW.
- **Tách stem**: Auto split rồi tải bản trộn và từng nhạc cụ (Bass, Guitar, Strings…), tất cả 32-bit.
- **Tạo nhạc**: điền form Create (Advanced) theo mô tả của bạn rồi bấm Create.

> Không liên kết với Suno, Inc. Extension chỉ bấm những nút bạn vẫn tự bấm, theo tốc độ người dùng,
> dừng lại khi Suno hỏi "bạn có phải người không", không vượt hạn mức của tài khoản bạn.

## Cần có

| | |
|---|---|
| Máy | Windows 10/11 |
| Trình duyệt | Google Chrome 116 trở lên, đã đăng nhập suno.com |
| Python | 3.10 trở lên ([python.org](https://www.python.org/downloads/), khi cài nhớ tick **Add python.exe to PATH**) |
| Trợ lý AI có MCP | Claude Code, Codex, Antigravity… |
| Gói Suno | **Premier** cho các việc dùng Studio (tải WAV, xuất 32-bit, tách stem). Tạo nhạc: gói nào cũng được, miễn đủ credit |

## Cài đặt (5 phút, làm 1 lần)

1. **Giải nén** gói vào một chỗ cố định, ví dụ `D:\GOHA-Suno-Helper`. Sau khi cài thì đừng di chuyển thư mục này.
2. **Chạy `CAI-DAT.bat`** (bấm đúp). File này kiểm Python, cài thư viện cho cầu nối, rồi mở thư mục `extension`.
3. **Nạp extension vào Chrome**:
   - Mở `chrome://extensions`, bật **Chế độ dành cho nhà phát triển** (góc phải trên).
   - Bấm **Tải tiện ích đã giải nén**, chọn thư mục `extension` trong gói.
   - Ghim biểu tượng GOHA Suno Helper lên thanh công cụ cho tiện.
4. **Nối trợ lý AI**: bấm biểu tượng GOHA Suno Helper để mở bảng bên, vào tab **Cài đặt**, bấm **Copy cấu hình MCP**.
   Dán vào ô chat của trợ lý AI và nói: *"cài MCP này giúp tôi"*. Xong thì **mở lại trợ lý**.
5. Mở **suno.com**, đăng nhập. Viên trạng thái trên bảng bên chuyển xanh **Sẵn sàng** là xong.

## Giao việc: nói với trợ lý AI

Mỗi đợt việc gom vào một **dự án** (tên ngắn chữ thường không dấu, ví dụ `lofi-thang10`). File tải về nằm ở
`Tải xuống\GOHA-Suno\<tên dự án>\`.

| Bạn nói | Trợ lý làm |
|---|---|
| "Tải WAV 3 bài này về dự án lofi: suno.com/song/…, suno.com/song/…, suno.com/song/…" | `suno_download_songs` |
| "Xuất bản 32-bit bài suno.com/song/… vào dự án master" | `suno_export_32bit` |
| "Tách stem bài suno.com/song/… để mix lại" | `suno_split_stems`, chạy thử trước rồi hỏi bạn trước khi tiêu credit |
| "Tạo 2 lượt bài lofi piano mưa đêm, 3 phút, không lời, dự án lofi" | `suno_generate`, chạy thử trước rồi hỏi bạn trước khi tiêu credit |
| "Việc chạy tới đâu rồi?" | `suno_jobs`, `suno_status` |

Link bài phải là dạng `suno.com/song/<mã bài>`. Link rút gọn `suno.com/s/…` không có mã bài: mở link đó ra rồi copy lại.

## An toàn credit

- **Tạo nhạc** và **tách stem** (50 credit/bài chưa tách) chỉ chạy thật khi trợ lý gửi kèm xác nhận tiêu credit.
  Trợ lý được dặn luôn chạy thử trước và hỏi bạn.
- Bài đã tách stem rồi thì không tách lại lần nữa: extension tự thấy và chỉ tải.
- Mất kết nối giữa lúc đang tạo hoặc tách thì việc đó dừng ở trạng thái **không rõ**, không tự chạy lại. Hãy xem trên Suno trước.
- Khi dự án còn một lượt tạo nhạc thật chưa rõ kết quả, cầu nối từ chối lượt tạo thật mới (tránh bấm Create hai lần);
  muốn tạo thêm có chủ đích thì nói rõ với trợ lý.
- Chạy lại một việc tạo/tách thật đã dừng cũng cần bạn xác nhận lại.
- Nút **DỪNG NGAY** ở đáy bảng bên dừng việc đang chạy và tạm dừng hàng chờ. Riêng lúc Suno đang tạo hoặc tách
  (credit đã trừ), nút này để việc đó chạy nốt rồi mới dừng.

## Xử lý sự cố

| Gặp | Làm |
|---|---|
| Viên trạng thái mãi "Chưa nối" | Trợ lý AI chưa chạy cầu nối: mở lại trợ lý; vẫn chưa được thì chạy lại `CAI-DAT.bat` và copy lại cấu hình MCP |
| Chrome hỏi cho phép truy cập mạng cục bộ | Bấm **Cho phép**: cầu nối chỉ nghe trên `127.0.0.1` của máy bạn |
| "Cần bạn: Suno hỏi bạn có phải người không" | Tự giải ô xác nhận trong tab Suno, rồi bấm **Chạy tiếp** |
| "Cửa sổ Suno đang bị che" | Đưa cửa sổ Chrome có tab Suno lên, việc tự chạy tiếp |
| Trợ lý báo không đọc được bài | Kiểm link đúng dạng `suno.com/song/…`; bài đang để riêng tư thì chuyển sang công khai (Public) hoặc không công khai (Unlisted) |
| Trợ lý báo bài chưa tạo xong | Đợi Suno tạo xong bài rồi giao lại |
| Chuyển thư mục cài | Chạy lại `CAI-DAT.bat`, copy lại cấu hình MCP |

## Giới hạn hiện tại

- Tạo nhạc mới dùng được bản **không lời** (bộ lái chưa điền ô Lyrics).
- Tab Thư viện đang làm.
- Suno đổi giao diện thì có thể làm extension gãy. Báo lỗi ở Group Facebook **Nông Dân Học AI Kiếm Tiền** hoặc mục Issues trên GitHub.

## Gỡ cài

Xoá extension ở `chrome://extensions`, xoá dòng `jr-suno` khỏi cấu hình MCP của trợ lý, rồi xoá thư mục gói.
Trong thư mục người dùng (gõ `%USERPROFILE%` vào thanh địa chỉ Explorer) còn hai thư mục nhỏ xoá được: `GOHA-Suno` (danh sách việc) và
`.jr-suno-bridge` (trạng thái cầu nối).
