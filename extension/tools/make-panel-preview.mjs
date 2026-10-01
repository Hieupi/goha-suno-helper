// Sinh dev/panel-preview.html từ sidepanel.html: cùng một khung giao diện, chỉ thêm chrome.* giả (dev/fake-chrome.js)
// và đổi đường dẫn tương đối. Không sửa tay trang xem trước — chạy lại lệnh này sau mỗi lần sửa sidepanel.html:
//   node tools/make-panel-preview.mjs
// tests/manifest.test.mjs kiểm trang xem trước luôn khớp.
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);

/** HTML trang xem trước dựng từ HTML side panel thật. */
export function previewHtml(sidepanel) {
  return sidepanel
    .replace("<title>GOHA Suno Helper</title>", "<title>GOHA Suno Helper — xem trước (dev)</title>")
    .replace('<script src="ui/skin.js"></script>', '<script src="fake-chrome.js"></script>\n  <script src="../ui/skin.js"></script>')
    .replaceAll('href="ui/', 'href="../ui/')
    .replace('<script src="sidepanel.js" type="module"></script>', '<script src="../sidepanel.js" type="module"></script>');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const html = previewHtml(readFileSync(new URL("sidepanel.html", ROOT), "utf8"));
  writeFileSync(new URL("dev/panel-preview.html", ROOT), html);
  console.log("dev/panel-preview.html đã sinh lại từ sidepanel.html");
}
