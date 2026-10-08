// Side panel JR Suno Helper: đọc trạng thái thật do service worker ghi (chrome.storage.session) và vẽ
// 5 mục. Không hiện/giữ mã kết nối ngoài ô nhập; không bịa số liệu — phần chưa có dữ liệu hiện trạng thái rỗng.
import { h, icon, mount } from "./ui/dom.js";
import {
  STORAGE,
  agoText,
  durationText,
  episodeShort,
  heroFor,
  humanNextStep,
  humanReason,
  kindLabel,
  licenseFor,
  phaseLabel,
  pillFor,
  timelineFor,
  versionLine
} from "./lib/ui-status.js";
import { queueOverview } from "./lib/queue-view.js";
import { progressCard, runbarProgress, slotList } from "./ui/queue-panel.js";
import { aboutView } from "./ui/about-panel.js";
import { BRIDGE_ADDRESS, DEFAULT_BRIDGE_PATH, cleanBridgePath, installInfo, maskCode, mcpConfig, newPairingCode, validPairingCode } from "./lib/pairing.js";

const VIEWS = ["overview", "queue", "library", "log", "settings", "about"];
const manifest = chrome.runtime.getManifest();
const model = { status: null, lastBridgeError: null, currentJob: null, activity: [], queue: null, notify: true, bridgeVersion: null, hasToken: false, sunoTab: null, bridgePath: "", python: "" };

/** install.json cạnh extension (CAI-DAT.bat ghi): đường dẫn cầu nối + python của máy này. Không có (bản dev) → rỗng. */
async function readInstallInfo() {
  try {
    const response = await fetch(chrome.runtime.getURL("install.json"), { cache: "no-store" });
    return response.ok ? installInfo(await response.json()) : installInfo(null);
  } catch {
    return installInfo(null);
  }
}
const installed = readInstallInfo();
// Mã kết nối chỉ nằm trong biến này để sao chép; không vẽ ra màn hình trừ khi chủ kênh bấm "Hiện mã".
let pairingCode = "";
const ui = { reveal: false };
const $ = (id) => document.getElementById(id);

// ── dữ liệu ─────────────────────────────────────────────────────────────────────────────────

async function load() {
  const session = await chrome.storage.session.get(["status", "lastBridgeError", "bridgeVersion", STORAGE.currentJob, STORAGE.queue]);
  const stored = await chrome.storage.local.get(["pairingToken", "bridgePath", STORAGE.activity, STORAGE.notify]);
  const { pairingToken, bridgePath } = stored;
  if (!validPairingCode(pairingToken)) {
    // Lần đầu: extension tự tạo mã — chủ kênh không phải xin mã ở đâu cả.
    await chrome.storage.local.set({ pairingToken: newPairingCode((n) => crypto.getRandomValues(new Uint8Array(n))) });
    return; // storage.onChanged gọi lại load()
  }
  pairingCode = pairingToken;
  const install = await installed;
  // Đường dẫn chủ kênh tự sửa (hoặc cầu nối báo) thắng; chưa có thì lấy từ trình cài.
  model.bridgePath = bridgePath || install.bridgePath;
  model.python = install.python;
  model.status = session.status ?? null;
  model.lastBridgeError = session.lastBridgeError ?? null;
  model.currentJob = session[STORAGE.currentJob] ?? null;
  model.activity = stored[STORAGE.activity] ?? [];
  model.notify = stored[STORAGE.notify] !== false;
  model.queue = session[STORAGE.queue] ?? null;
  model.bridgeVersion = session.bridgeVersion ?? null;
  model.hasToken = Boolean(pairingToken);
  model.sunoTab = (await chrome.tabs.query({ url: "https://suno.com/*" }))[0] ?? null;
  render();
}

async function focusSuno() {
  const [tab] = await chrome.tabs.query({ url: "https://suno.com/*" });
  if (!tab) return chrome.tabs.create({ url: "https://suno.com/create" });
  await chrome.tabs.update(tab.id, { active: true });
  return chrome.windows.update(tab.windowId, { focused: true });
}

function toast(text, tone = "matsu") {
  const note = h("div", { class: "toast" }, icon(tone === "shu" ? "i-alert" : "i-check"), h("span", {}, text));
  $("toastHost").append(note);
  setTimeout(() => note.remove(), 4500);
}

async function stopNow() {
  const reply = await chrome.runtime.sendMessage({ type: "jr.ui", action: "stop" }).catch(() => null);
  if (!reply) return toast("Chưa gửi được lệnh dừng — thử lại sau vài giây.", "shu");
  if (reply.finishing) return toast("Việc này đã bấm Create nên để chạy xong (tránh tốn credit hai lần). Hàng chờ đã tạm dừng.");
  return toast("Đã dừng. Hàng chờ tạm dừng — không mất việc nào.");
}

/** Bộ lái đang đứng chờ cửa sổ Suno hiện lại — hiện là tự chạy tiếp, không cần "Chạy tiếp". */
function waitingForWindow() {
  return model.status?.kind === "human" && model.status.detail === "tab_hidden_wait";
}

async function runOn() {
  const reply = await chrome.runtime.sendMessage({ type: "jr.ui", action: "resume" }).catch(() => null);
  if (!reply?.sent) return toast("Chưa nối được cầu nối — mở trợ lý AI rồi thử lại.", "shu");
  return toast("Đã bảo chạy tiếp. Việc chưa kịp làm gì trên Suno sẽ chạy lại; việc dở dang hơn chờ trợ lý AI xem.");
}

// ── khung: tab, da, viên trạng thái, thanh chạy ─────────────────────────────────────────────

function selectView(name, focus = false) {
  const view = VIEWS.includes(name) ? name : "overview";
  for (const key of VIEWS) {
    const selected = key === view;
    $(`tab-${key}`).setAttribute("aria-selected", String(selected));
    $(`tab-${key}`).tabIndex = selected ? 0 : -1;
    $(`view-${key}`).hidden = !selected;
  }
  if (focus) $(`tab-${view}`).focus();
  history.replaceState(null, "", `#${view}`);
}

function currentView() {
  return VIEWS.find((key) => !$(`view-${key}`).hidden) ?? "overview";
}

const license = licenseFor(manifest);
// Phiên bản ngay sau tên (kiểu GOHA Flow): không đổi khi đang chạy nên điền một lần.
$("brandVer").textContent = `v${manifest.version}`;

/** Chân trang: huy hiệu bản quyền + "Ext v… · App v…" (App = cầu nối; chỉ tin khi đang nối). */
function renderFooter() {
  const connected = ["on", "run", "human"].includes(model.status?.kind);
  const line = versionLine(manifest.version, connected ? model.bridgeVersion : null);
  $("footVer").textContent = line.text;
  $("footVer").title = line.text;
  $("footVer").className = line.warn ? "foot-ver warn" : "foot-ver";
  $("licBadge").className = license.premium ? "lic-badge" : "lic-badge is-trial";
  $("licBadge").title = license.title;
  $("licLabel").textContent = license.label;
}

function versionTile() {
  return versionLine(manifest.version, ["on", "run", "human"].includes(model.status?.kind) ? model.bridgeVersion : null);
}

function licenseCard() {
  const connected = ["on", "run", "human"].includes(model.status?.kind);
  const line = versionLine(manifest.version, connected ? model.bridgeVersion : null);
  return h("section", { class: `card set-block lic-card${license.premium ? "" : " hl"}`, id: "licCard" },
    h("div", { class: "chead" }, icon("i-crown", "i20"),
      h("div", {}, h("h3", {}, license.premium ? "GOHA Suno Helper · PREMIUM" : "GOHA Suno Helper · Dùng thử"),
        h("div", { class: "meta" }, license.title))),
    h("ul", { class: "feat" },
      h("li", {}, "Tải WAV hàng loạt qua Studio export (gói Premier)"),
      h("li", {}, "Xuất bản 32-bit float miễn phí (Multitrack)"),
      h("li", {}, "Tách stem + tải bản trộn và từng nhạc cụ 32-bit để mix trên DAW"),
      h("li", {}, "Tạo nhạc hàng loạt — luôn hỏi bạn trước khi tiêu credit"),
      h("li", {}, "Tiến độ cả dự án, thông báo Windows, tự chạy tiếp khi cửa sổ hiện lại")),
    h("dl", { class: "kv" },
      h("dt", {}, "Extension"), h("dd", {}, `v${manifest.version}`),
      h("dt", {}, "App (cầu nối)"), h("dd", {}, connected && model.bridgeVersion ? `v${model.bridgeVersion}` : "chưa nối")),
    line.warn ? h("p", { class: "note" }, "Extension và cầu nối khác bản: đóng rồi mở lại trợ lý AI để nạp cầu nối mới.") : null);
}

function renderChrome() {
  const pill = pillFor(model.status?.kind, model.hasToken);
  $("statusPill").className = `pill ${pill.tone}`;
  $("statusPill").firstElementChild.className = model.status?.kind === "run" ? "dot pulse" : "dot";
  $("statusText").textContent = pill.text;
  $("skinName").textContent = document.documentElement.dataset.skin === "classic" ? "Cổ điển" : "Neon";
  const job = model.currentJob;
  const running = model.status?.kind === "run" && job;
  $("runbar").hidden = !running;
  if (running) {
    $("runTitle").textContent = job.title || kindLabel(job.kind);
    $("runStep").textContent = `${phaseLabel(job.phase)} · ${durationText(Date.now() - job.startedAt)}${runbarProgress(overview().focus)}`;
  }
}

// ── các mục ───────────────────────────────────────────────────────────────────────────────────

/** Toàn cảnh hàng chờ từ ảnh cầu nối gửi; cầu nối mất kết nối thì ảnh cũ vẫn hiện, kèm giờ chụp. */
function overview() {
  return queueOverview(model.queue, Date.now());
}

function staleNote() {
  const kind = model.status?.kind;
  if (!model.queue || kind === "on" || kind === "run" || kind === "human") return null;
  return h("p", { class: "note" }, `Ảnh hàng chờ lúc ${clockText(model.queue.receivedAt)} — cầu nối đang mất kết nối nên có thể đã cũ.`);
}

function heroCard() {
  const hero = heroFor(model);
  const actions = {
    settings: h("button", { class: "btn primary", type: "button", onclick: () => selectView("settings", true) }, "Kết nối trợ lý AI"),
    suno: waitingForWindow()
      ? h("button", { class: "btn primary", type: "button", onclick: focusSuno }, icon("i-ext"), "Đưa cửa sổ Suno lên")
      : [h("button", { class: "btn primary", type: "button", onclick: runOn }, icon("i-redo"), "Chạy tiếp"),
        h("button", { class: "btn", type: "button", onclick: focusSuno }, icon("i-ext"), "Mở tab Suno")],
    queue: h("button", { class: "btn", type: "button", onclick: () => selectView("queue", true) }, "Xem việc đang chạy")
  };
  return h("section", { class: `card hl ${hero.tone}` },
    h("h3", {}, hero.title), h("p", {}, hero.body), hero.action ? h("div", { class: "btns" }, actions[hero.action]) : null);
}

function tile(title, state, text, button = null) {
  return h("div", { class: "tile" }, h("b", {}, icon(state === "ok" ? "i-check" : "i-alert"), title), h("span", { class: state }, text), button);
}

function renderOverview() {
  const kind = model.status?.kind;
  const bridgeOk = kind === "on" || kind === "run" || kind === "human";
  const view = overview();
  mount($("view-overview"),
    heroCard(),
    view.focus ? progressCard(view.focus, { paused: view.paused, now: Date.now(), waiting: waitingForWindow(), onMore: () => selectView("queue", true), onResume: model.status?.kind === "human" ? null : runOn }) : null,
    view.focus ? staleNote() : null,
    h("div", { class: "grid2" },
      tile("Cầu nối", bridgeOk ? "ok" : "warn", bridgeOk ? "Đã kết nối" : "Chưa kết nối"),
      tile("Tab Suno", model.sunoTab ? "ok" : "warn", model.sunoTab ? "Đang mở" : "Chưa mở",
        h("button", { class: "btn", type: "button", onclick: focusSuno }, model.sunoTab ? "Chuyển tới" : "Mở Suno")),
      tile("Trợ lý AI", bridgeOk ? "ok" : "warn", bridgeOk ? "Đã kết nối" : "Chưa kết nối",
        bridgeOk ? null : h("button", { class: "btn", type: "button", onclick: () => selectView("settings", true) }, "Kết nối")),
      tile("Phiên bản", versionTile().warn ? "warn" : "ok", versionTile().text)),
    h("p", { class: "note" }, "Mình không đọc cookie hay mật khẩu Suno, và luôn dừng lại khi Suno hỏi bạn có phải người không."));
}

function jobCard(job) {
  const steps = timelineFor(job);
  const at = steps.findIndex((s) => s.state === "now");
  const percent = steps.length ? Math.round(((at < 0 ? 0 : at) + 0.5) / steps.length * 100) : 0;
  const where = [episodeShort(job.episode), job.slot ? `ô ${String(job.slot).padStart(2, "0")}` : null].filter(Boolean).join(" · ");
  return h("section", { class: "card hl ai" },
    h("div", { class: "chead" }, icon(job.kind === "generate" ? "i-music" : "i-down", "i20"),
      h("div", {}, h("h3", {}, job.title || kindLabel(job.kind)), h("div", { class: "meta" }, `${kindLabel(job.kind)}${where ? ` · ${where}` : ""}`))),
    h("div", { class: "progress" }, h("b", { style: `width:${percent}%` })),
    h("ol", { class: "tl" }, steps.map((s) => h("li", { class: s.state },
      h("span", { class: "n" }, s.state === "done" ? icon("i-check") : null), h("span", {}, s.label),
      s.state === "now" ? h("time", {}, durationText(Date.now() - job.phaseAt)) : h("time", {}, "")))),
    h("p", { class: "meta" }, `Bắt đầu ${agoText(job.startedAt)}`));
}

function renderQueue() {
  const parts = [];
  if (model.status?.kind === "human") {
    parts.push(h("section", { class: "card hl shu" },
      h("div", { class: "chead" }, icon("i-hand", "i20"), h("h3", {}, `Cần bạn xử lý: ${humanReason(model.status.detail)}`)),
      h("p", {}, humanNextStep(model.status.detail)),
      h("div", { class: "btns" }, waitingForWindow()
        ? h("button", { class: "btn primary lg", type: "button", onclick: focusSuno }, icon("i-ext"), "Đưa cửa sổ Suno lên")
        : [h("button", { class: "btn primary lg", type: "button", onclick: runOn }, icon("i-redo"), "Chạy tiếp"),
          h("button", { class: "btn lg", type: "button", onclick: focusSuno }, icon("i-ext"), "Mở tab Suno")])));
  }
  const view = overview();
  if (model.currentJob && model.status?.kind === "run") parts.push(h("div", { id: "jobHost" }, jobCard(model.currentJob)));
  for (const ep of view.episodes.filter((e) => e === view.focus || e.counts.active + e.counts.queued + e.counts.human)) {
    parts.push(progressCard(ep, { paused: view.paused, now: Date.now(), waiting: waitingForWindow(), onResume: model.status?.kind === "human" ? null : runOn }), slotList(ep));
  }
  if (view.episodes.length) parts.push(staleNote());
  else if (!(model.currentJob && model.status?.kind === "run") && model.status?.kind !== "human") {
    parts.push(h("div", { class: "empty" }, icon("i-list"), h("b", {}, "Chưa có việc nào đang chạy"),
      h("span", {}, "Bảo trợ lý AI của bạn giao việc — ví dụ: “tải bài suno.com/song/… về dự án lofi”.")));
  }
  parts.push(h("p", { class: "note" }, "Nút duyệt việc tốn credit ngay trong bảng này sẽ có ở bản nâng cấp tới; hiện trợ lý AI hỏi bạn trước khi gen thật."));
  mount($("view-queue"), parts);
}

function renderLibrary() {
  mount($("view-library"),
    h("div", { class: "empty" }, icon("i-music"), h("b", {}, "Thư viện Suno — sắp có"),
      h("span", {}, "Quét các bài trong thư viện Suno của bạn, lọc theo tên, độ dài, ngày; chọn nhiều bài để tải WAV hoặc tạo lại.")),
    h("p", { class: "note" }, "Hiện giờ trợ lý AI tải, tạo nhạc, xuất 32-bit và tách stem theo danh sách bài bạn đưa."));
}

function clockText(at) {
  return new Date(at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderLog() {
  const entries = [...model.activity].reverse();
  mount($("view-log"),
    h("div", { class: "toolbar" }, h("b", { class: "spacer" }, `Nhật ký (${entries.length})`),
      h("button", { class: "btn ghost", type: "button", onclick: () => chrome.runtime.sendMessage({ type: "jr.ui", action: "clear_log" }).catch(() => {}) }, "Xoá nhật ký")),
    entries.length
      ? h("ol", { class: "log" }, entries.map((e) => h("li", {}, h("time", {}, clockText(e.at)), h("span", { class: e.level }, e.text))))
      : h("div", { class: "empty" }, icon("i-log"), h("b", {}, "Chưa có sự kiện nào"), h("span", {}, "Mỗi lần nhận việc, xong việc hay cần bạn xử lý, mình ghi lại ở đây.")));
}

function segButtons(options, current, onPick) {
  return h("div", { class: "seg", role: "group" }, options.map(([value, label]) =>
    h("button", { type: "button", "aria-pressed": String(value === current), onclick: () => onPick(value) }, label)));
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast("Chưa sao chép được — bấm vào khung cấu hình, chọn hết (Ctrl+A) rồi Ctrl+C.", "shu");
  }
}

async function rotateCode() {
  const ok = confirm("Tạo mã mới?\n\nTrợ lý AI đang dùng mã cũ sẽ không kết nối được cho tới khi bạn sao chép lại cấu hình và mở lại trợ lý.");
  if (!ok) return;
  ui.reveal = false;
  await chrome.storage.local.set({ pairingToken: newPairingCode((n) => crypto.getRandomValues(new Uint8Array(n))) });
  toast("Đã tạo mã mới — sao chép lại cấu hình cho trợ lý AI.");
}

function connectCard() {
  const kind = model.status?.kind;
  const connected = kind === "on" || kind === "run" || kind === "human";
  const shown = mcpConfig({ code: ui.reveal ? pairingCode : maskCode(pairingCode), bridgePath: model.bridgePath, python: model.python });
  const real = mcpConfig({ code: pairingCode, bridgePath: model.bridgePath, python: model.python });
  const pathInput = h("input", {
    type: "text",
    value: model.bridgePath || DEFAULT_BRIDGE_PATH,
    spellcheck: "false",
    "aria-label": "Đường dẫn tới cầu nối",
    onchange: (event) => chrome.storage.local.set({ bridgePath: cleanBridgePath(event.target.value) })
  });
  return h("section", { class: `card set-block${connected ? "" : " hl"}` },
    h("div", { class: "chead" }, icon("i-bot", "i20"),
      h("div", {}, h("h3", {}, "Kết nối trợ lý AI"), h("div", { class: "meta" }, "Claude Code · Codex · Antigravity — qua MCP trên máy này"))),
    h("p", { class: "note" }, connected
      ? "Đã kết nối. Chỉ cần copy lại khi đổi máy, đổi trợ lý hoặc tạo mã mới."
      : "Copy khối dưới, dán vào ô chat của trợ lý AI và nói “cài MCP này giúp tôi”. Mở lại trợ lý là xong."),
    h("pre", { class: "code", tabindex: "0", "aria-label": "Cấu hình MCP" }, shown),
    h("div", { class: "btns" },
      h("button", { class: "btn primary lg", type: "button", onclick: () => copyText(real, "Đã copy cấu hình MCP — dán vào trợ lý AI của bạn.") }, icon("i-copy"), "Copy cấu hình MCP"),
      h("button", { class: "btn ghost", type: "button", onclick: () => { ui.reveal = !ui.reveal; renderSettings(); } }, icon("i-eye"), ui.reveal ? "Ẩn mã" : "Hiện mã")),
    h("details", { class: "more" },
      h("summary", {}, "Nâng cao"),
      h("div", { class: "stack" },
        h("span", { class: "meta" }, `Cầu nối: ${BRIDGE_ADDRESS} · mã kết nối: ${maskCode(pairingCode)}`),
        h("label", { class: "meta" }, "Đường dẫn cầu nối (tự điền, chỉ sửa khi chuyển thư mục dự án)"),
        h("div", { class: "field" }, h("div", { class: "inp" }, pathInput)),
        h("div", { class: "btns" }, h("button", { class: "btn ghost", type: "button", onclick: () => void rotateCode() }, icon("i-redo"), "Tạo mã mới")))));
}

function renderSettings() {
  const { skin, theme } = window.jrSkin.get();
  mount($("view-settings"),
    licenseCard(),
    connectCard(),
    h("section", { class: "card set-block" }, h("h3", {}, "Giao diện"),
      segButtons([["neon", "Neon"], ["classic", "Cổ điển"]], skin, (value) => window.jrSkin.set({ skin: value })),
      h("div", { class: "theme-only stack" }, h("span", { class: "meta" }, "Độ sáng (chỉ kiểu Cổ điển)"),
        segButtons([["system", "Theo máy"], ["light", "Sáng"], ["dark", "Tối"]], theme, (value) => window.jrSkin.set({ theme: value })))),
    h("section", { class: "card set-block" }, h("h3", {}, "Thông báo Windows"),
      h("p", { class: "note" }, "Báo khi cần bạn, khi cửa sổ Suno bị che, và khi chạy xong cả dự án. Bấm vào thông báo để đưa cửa sổ Suno lên."),
      segButtons([[true, "Bật"], [false, "Tắt"]], model.notify, (value) => chrome.storage.local.set({ [STORAGE.notify]: value }))),
    h("section", { class: "card set-block" }, h("h3", {}, "An toàn"),
      h("p", { class: "note" }, "Không đọc cookie, mật khẩu hay phiên đăng nhập Suno. Gặp ô xác nhận “bạn có phải người”, đăng xuất hoặc tab bị đóng/ẩn: mình dừng lại và báo bạn. Chỉ dùng một tab Suno. Mã kết nối chỉ nằm trong extension và trong cấu hình trợ lý AI trên máy này.")),
    h("p", { class: "note" }, `GOHA Suno Helper ${manifest.version_name ?? manifest.version}`));
}

/** Tab Giới thiệu: dữ liệu tĩnh, vẽ một lần (không phụ thuộc trạng thái cầu nối). */
function renderAbout() {
  mount($("view-about"), aboutView({ version: manifest.version_name ?? manifest.version, copyText }));
}

function render() {
  renderChrome();
  renderFooter();
  renderOverview();
  renderQueue();
  renderLibrary();
  renderLog();
  if (!$("view-settings").contains(document.activeElement)) renderSettings();
}

// ── sự kiện ─────────────────────────────────────────────────────────────────────────────────

for (const key of VIEWS) $(`tab-${key}`).addEventListener("click", () => selectView(key));
document.querySelector(".tabs").addEventListener("keydown", (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  const next = VIEWS[(VIEWS.indexOf(currentView()) + step + VIEWS.length) % VIEWS.length];
  selectView(next, true);
});
$("skinBtn").addEventListener("click", () => window.jrSkin.set({ skin: document.documentElement.dataset.skin === "neon" ? "classic" : "neon" }));
$("stopBtn").addEventListener("click", () => void stopNow());
$("licBadge").addEventListener("click", () => {
  selectView("settings", true);
  $("licCard")?.scrollIntoView({ block: "start" });
});
document.addEventListener("jr:skin", () => { renderChrome(); renderSettings(); });
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "session" || area === "local") void load(); });
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === "complete") void load(); });
chrome.tabs.onRemoved.addListener(() => void load());
// Mỗi giây chỉ vẽ lại thẻ việc đang chạy (đồng hồ bước), không đụng lưới từng bài (giữ tooltip / vị trí cuộn).
setInterval(() => {
  if (!(model.currentJob && model.status?.kind === "run")) return;
  renderChrome();
  const host = $("jobHost");
  if (host) mount(host, jobCard(model.currentJob));
}, 1000);
setInterval(() => { if (model.queue) renderOverview(); }, 30_000); // "xong lúc ~hh:mm" trôi theo giờ

renderAbout();
selectView(location.hash.slice(1));
void load();
void chrome.runtime.sendMessage({ type: "jr.ui", action: "connect" }).catch(() => {});
