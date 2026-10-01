// Trạng thái hiển thị dùng chung cho service worker (badge + tooltip) và side panel (chữ tiếng Việt).
// Logic thuần, không chạm chrome.* — test bằng node --test (tests/ui-status.test.mjs).
// Badge không dùng chữ tiếng Anh (design-spec §7.3): phân biệt bằng ký hiệu + tooltip, không chỉ bằng màu.

export const STATUS_KINDS = Object.freeze(["off", "key", "on", "run", "human"]);

/** Khoá chrome.storage.session do controller ghi, side panel đọc. */
// currentJob/queue: storage.session; activity (nhật ký) + notify (công tắc thông báo): storage.local.
export const STORAGE = Object.freeze({ currentJob: "jrCurrentJob", activity: "jrActivity", queue: "jrQueue", notify: "jrNotify" });

const PILLS = Object.freeze({
  off: { tone: "kohaku", text: "Chưa nối" },
  key: { tone: "mute", text: "Chưa thiết lập" },
  on: { tone: "matsu", text: "Sẵn sàng" },
  run: { tone: "ai", text: "Đang chạy" },
  human: { tone: "shu", text: "Cần bạn" }
});

/** Viên trạng thái trên header: màu + chữ ngắn. */
export function pillFor(kind, hasToken = true) {
  if (!hasToken) return PILLS.key;
  return PILLS[kind] ?? PILLS.off;
}

/**
 * Huy hiệu bản quyền ở chân trang (như GOHA Flow: PREMIUM vàng kim + vương miện). Bản nạp thẳng từ thư mục
 * (không có update_url) là máy dev của chủ kênh: PREMIUM vĩnh viễn. Bản phát hành chưa có key = DÙNG THỬ (P8).
 */
export function licenseFor(manifest) {
  if (!manifest?.update_url) return { premium: true, label: "PREMIUM", title: "Bản tặng cộng đồng — mọi tính năng đã mở, miễn phí vĩnh viễn" };
  return { premium: false, label: "DÙNG THỬ", title: "Bản dùng thử — bấm để xem gói Premium" };
}

/** "Ext v0.3.2 · App v0.3.2" — App là cầu nối trên máy; lệch bản thì cảnh báo (mở lại trợ lý AI để nạp cầu nối mới). */
export function versionLine(extVersion, bridgeVersion) {
  if (!bridgeVersion) return { text: `Ext v${extVersion} · App chưa nối`, warn: false };
  const same = extVersion === bridgeVersion;
  return {
    text: `Ext v${extVersion} · App v${bridgeVersion}${same ? "" : " — lệch bản, mở lại trợ lý AI"}`,
    warn: !same
  };
}

/** "Tải WAV" / "Tạo nhạc" theo loại việc. */
export function kindLabel(kind) {
  if (kind === "multitrack_export") return "Xuất 32-bit";
  if (kind === "stems_split") return "Tách stem";
  return kind === "generate" ? "Tạo nhạc" : "Tải WAV";
}

/** "EP008-winter-edo-reading-room" → "EP008"; dự án ("lofi-album") giữ nguyên tên. */
export function episodeShort(episode) {
  const text = String(episode ?? "");
  return /^EP\d{3}(?:-|$)/.test(text) ? text.split("-")[0] : text;
}

/** "4 phút 05 giây" cho đồng hồ việc đang chạy. */
export function durationText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return minutes ? `${minutes} phút ${seconds} giây` : `${total % 60} giây`;
}

const BADGE = Object.freeze({
  off: { text: "…", color: "#475569" }, // chưa nối cầu nối — đang thử lại
  key: { text: "•", color: "#475569" }, // chưa có mã kết nối
  on: { text: "", color: "#475569" }, // sẵn sàng: không badge
  run: { text: "▶", color: "#0E7490" }, // đang chạy việc (trắng trên #0E7490 = 5.36:1)
  human: { text: "!", color: "#B8321F" } // cần bạn xử lý (5.98:1)
});

const PHASES = Object.freeze({
  opening_studio: "Mở Studio của bài",
  exporting: "Xuất bản đầy đủ",
  checking_export: "Chờ Suno chuẩn bị file",
  opening_song: "Mở trang bài",
  downloading: "Đang tải WAV",
  exporting_multitrack: "Xuất Multitrack, tải ZIP 32-bit",
  opening_stems: "Mở hộp tách stem của bài",
  extracting: "Suno đang tách stem (50 credit)",
  opening_stems_studio: "Mở Studio có đủ stem",
  filling_form: "Điền form Create",
  submitting: "Bấm Create",
  rendering: "Suno đang tạo nhạc"
});

export const PHASE_ORDER = Object.freeze({
  export_download: ["opening_studio", "exporting", "checking_export", "opening_song", "downloading"],
  generate: ["filling_form", "submitting", "rendering"],
  multitrack_export: ["opening_studio", "exporting_multitrack"],
  stems_split: ["opening_stems", "extracting", "opening_stems_studio", "exporting_multitrack"]
});

const HUMAN_REASONS = Object.freeze({
  captcha: "Suno hỏi bạn có phải người không",
  logged_out: "Suno đã đăng xuất",
  tab_hidden: "Tab Suno bị ẩn hoặc thu nhỏ",
  tab_hidden_wait: "Cửa sổ Suno đang bị che",
  tab_closed: "Tab Suno đã bị đóng",
  quota_prompt: "Suno hiện hộp hạn mức",
  user_stop: "Bạn đã bấm Dừng ngay"
});

const HUMAN_NEXT = Object.freeze({
  captcha: "Bấm giải ô xác nhận trong tab Suno, rồi bấm “Chạy tiếp”.",
  logged_out: "Đăng nhập lại Suno, rồi bấm “Chạy tiếp”.",
  tab_hidden: "Đưa cửa sổ Suno lên trước, rồi bấm “Chạy tiếp”.",
  tab_hidden_wait: "Để cửa sổ Suno hiện ra (một góc màn hình cũng được) — mình đang chờ và sẽ tự chạy tiếp, không cần bấm gì.",
  tab_closed: "Mở lại tab Suno, rồi bấm “Chạy tiếp”.",
  quota_prompt: "Xem hộp thông báo của Suno, rồi bấm “Chạy tiếp”.",
  user_stop: "Hàng chờ đang tạm dừng. Khi muốn chạy lại, bấm “Chạy tiếp”."
});

export function phaseLabel(phase) {
  return PHASES[phase] ?? "Đang chuẩn bị";
}

export function humanReason(kind) {
  return HUMAN_REASONS[kind] ?? "Có việc cần bạn xem";
}

export function humanNextStep(kind) {
  return HUMAN_NEXT[kind] ?? "Xem tab Suno, rồi bấm “Chạy tiếp”.";
}

/** Badge + tooltip cho chrome.action theo trạng thái controller. */
export function badgeFor(kind, detail = "") {
  const badge = BADGE[kind] ?? BADGE.off;
  const titles = {
    off: "Chưa kết nối với trợ lý AI — mình đang thử lại",
    key: "Chưa thiết lập — bấm để kết nối trợ lý AI",
    on: "Sẵn sàng — đã kết nối với trợ lý AI",
    run: `Đang chạy: ${phaseLabel(detail)}`,
    human: `Cần bạn xử lý: ${humanReason(detail)}`
  };
  return { text: badge.text, color: badge.color, title: `GOHA Suno Helper — ${titles[kind] ?? titles.off}` };
}

/**
 * Thẻ trạng thái chính của side panel. `tone` khớp màu ngữ nghĩa của spec:
 * matsu = ổn, ai = đang chạy, shu = cần bạn, mute = chưa sẵn sàng.
 */
export function heroFor({ status, hasToken, lastBridgeError }) {
  const kind = status?.kind ?? (hasToken ? "off" : "key");
  if (!hasToken || kind === "key") {
    return { tone: "mute", title: "Chưa kết nối", body: "Mở Cài đặt, sao chép cấu hình vào trợ lý AI của bạn là xong.", action: "settings" };
  }
  if (kind === "human") {
    return { tone: "shu", title: `Cần bạn xử lý: ${humanReason(status.detail)}`, body: humanNextStep(status.detail), action: "suno" };
  }
  if (kind === "run") {
    return { tone: "ai", title: "Đang chạy việc", body: phaseLabel(status.detail), action: "queue" };
  }
  if (kind === "on") {
    return { tone: "matsu", title: "Sẵn sàng", body: "Đã kết nối cầu nối. Bảo trợ lý của bạn gửi việc là mình làm.", action: null };
  }
  const reason = lastBridgeError ? ` Lần cuối: ${lastBridgeError}` : "";
  return {
    tone: "kohaku",
    title: "Chưa thấy trợ lý AI",
    body: `Sao chép cấu hình ở Cài đặt, dán vào trợ lý AI rồi mở lại trợ lý. Mình tự thử lại mỗi phút.${reason}`,
    action: "settings"
  };
}

/** Dòng thời gian các bước của việc đang chạy: done / now / todo. */
export function timelineFor(job) {
  if (!job) return [];
  const order = PHASE_ORDER[job.kind] ?? [];
  const at = order.indexOf(job.phase);
  return order.map((phase, index) => ({
    phase,
    label: phaseLabel(phase),
    state: at < 0 ? "todo" : index < at ? "done" : index === at ? "now" : "todo"
  }));
}

/** "12 giây trước" / "3 phút trước" / "2 giờ trước" — cho nhật ký và nhịp tim. */
export function agoText(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} giây trước`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  return `${Math.round(minutes / 60)} giờ trước`;
}
