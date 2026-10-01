// Bộ điều khiển của service worker: nối cầu nối 127.0.0.1, chạy bộ máy trạng thái job (runner.js)
// và thực thi action của nó — điều hướng 1 tab Suno riêng, ra lệnh content script, đọc trạng thái
// clip công khai, gắn thư mục con cho ĐÚNG lượt tải của bản export, báo kết quả.
//
// Mọi phụ thuộc (chrome, WebSocket, hẹn giờ, fetch) truyền vào để test được với đồ giả
// (tests/controller.test.mjs). background.js chỉ gọi createController(...).start().
// Không đọc cookie/token/phiên Suno; không tiêm MAIN world; không đụng CAPTCHA.
import {
  DEFAULT_BRIDGE_URL,
  authMessage,
  bridgeProofInput,
  extensionProofInput,
  helloMessage,
  hmacHex,
  parseIncoming,
  randomNonce,
  sameHex
} from "./protocol.js";
import { AFTER_SPEND, IDLE, STEP_TIMEOUT_MS, orphanOf, step } from "./runner.js";
import { STORAGE, badgeFor, episodeShort, humanNextStep, humanReason, phaseLabel } from "./ui-status.js";
import { basename, downloadTarget } from "./naming.js";
import { reconnectDelayMs } from "./backoff.js";
import { downloadBelongsTo, isWav, isZip } from "./downloads.js";

const CLIP_ENDPOINT = "https://studio-api.prod.suno.com/api/clip/";
const CLIP_FETCH_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 20_000; // tin nhắn WebSocket giữ service worker sống (Chrome ≥ 116)
const CONTENT_EVENTS = new Set(["content_done", "content_error", "human_needed", "hidden"]);
const PENDING_KEY = "jrPending";
const OBSERVED_KEYS = 20; // khối generation_panel_observed ~14 khoá

/** Ảnh gọn của trang (content script → cầu nối): đường dẫn ≤ 80 ký tự, ≤ 40 nhãn chữ ≤ 60 ký tự. */
function pageHintOf(value) {
  if (!value || typeof value !== "object") return undefined;
  const labels = Array.isArray(value.labels) ? value.labels.filter((l) => typeof l === "string").slice(0, 40).map((l) => l.slice(0, 60)) : [];
  return { path: String(value.path ?? "").slice(0, 80), labels };
}

/** Chỉ nhận object phẳng giá trị nguyên thuỷ từ content script (khối form đọc lại). */
function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v));
  return Object.fromEntries(entries.slice(0, OBSERVED_KEYS).map(([k, v]) => [String(k).slice(0, 40), typeof v === "string" ? v.slice(0, 300) : v]));
}

// Side panel đọc hai khoá này (chrome.storage.session): việc đang chạy + nhật ký sự kiện gần nhất.
const CURRENT_JOB_KEY = STORAGE.currentJob;
const ACTIVITY_KEY = STORAGE.activity;
// Công tắc "Thông báo Windows" ở Cài đặt (storage.local); không có khoá = bật.
const NOTIFY_KEY = STORAGE.notify;
const OPEN_STATUSES = new Set(["queued", "sent", "running", "needs_human"]);
// Tự nạp lại (máy dev, cầu nối mới hơn): tối đa một lần mỗi 10 phút — lệch bản mãi cũng không lặp vô hạn.
const SELF_RELOAD_KEY = "jrLastSelfReload";
const SELF_RELOAD_GAP_MS = 10 * 60_000;
// DỪNG NGAY bấm lúc mất kết nối: nhớ qua cả lúc service worker ngủ, báo cầu nối trong lời chào lần nối sau.
const STOP_WANTED_KEY = "jrStopWanted";
const ACTIVITY_MAX = 60;

/** Tên hiển thị của job: tiêu đề bài (tải) hoặc tiêu đề packet (gen), cắt ngắn. */
function jobTitle(job) {
  return String(job?.expectedTitle ?? job?.packet?.title ?? job?.id ?? "").slice(0, 120);
}

export function createController({ chrome, WebSocketImpl, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn, fetchFn }) {
  const version = chrome.runtime.getManifest().version;
  const OPEN = WebSocketImpl.OPEN ?? 1;
  let socket = null;
  let attempt = 0;
  let reconnectTimer = null;
  let state = IDLE;
  let sunoTabId = null;
  let pendingCommand = null; // { tabId, command, payload } — gửi khi tab điều hướng xong
  let expecting = null; // { episode, exportId, title, downloadId } — lượt tải của bản export đang chờ
  // Job gen đã bấm Create mà mất dấu (mất kết nối / worker khởi động lại): giữ id để báo cầu nối.
  let orphan = null; // { jobId, phase, clipIds }
  // Mỗi lệnh content mang id riêng; báo cáo mang id cũ (bộ lái của job trước còn chạy) bị bỏ qua.
  let commandSeq = 0;
  let currentCommandId = null;
  let currentJobStartedAt = null;
  let lastJob = null; // { id, title } — để dòng nhật ký kết quả còn tên bài sau khi state về idle
  let reloadWanted = false; // cầu nối bảo nạp lại lúc đang bận: nạp khi rảnh hẳn
  const timers = new Map();
  // Bước đang treo vì tab Suno bị che (content script chờ cửa sổ hiện lại): hẹn giờ của bước này không được nổ.
  let heldPhase = null;

  // ── trạng thái hiển thị + lưu bền ─────────────────────────────────────────────────────────

  async function setStatus(kind, detail = "") {
    const badge = badgeFor(kind, detail);
    // Đang chạy: icon hiện số việc còn lại (từ ảnh hàng chờ của cầu nối) thay cho ▶.
    const text = kind === "run" && remainingJobs > 0 ? String(Math.min(remainingJobs, 99)) : badge.text;
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    await chrome.action.setTitle?.({ title: badge.title });
    await chrome.storage.session.set({ status: { kind, detail } });
  }

  // Nhật ký cho side panel: nối tiếp, giữ ACTIVITY_MAX dòng mới nhất, trong storage.local để còn sau khi tắt Chrome.
  // Ghi tuần tự để hai sự kiện sát nhau không đè nhau (đọc-sửa-ghi).
  let activityWrite = Promise.resolve();
  function logActivity(level, text) {
    activityWrite = activityWrite.then(async () => {
      const saved = (await chrome.storage.local.get(ACTIVITY_KEY))[ACTIVITY_KEY] ?? [];
      const next = [...saved, { at: Date.now(), level, text: String(text).slice(0, 200) }].slice(-ACTIVITY_MAX);
      await chrome.storage.local.set({ [ACTIVITY_KEY]: next });
    }).catch(() => {});
    return activityWrite;
  }

  /** Thông báo Windows (bấm vào → đưa cửa sổ Suno lên). Tắt được ở Cài đặt; lỗi thông báo không bao giờ chặn job. */
  async function notify(key, title, message) {
    if (!chrome.notifications?.create) return;
    try {
      if ((await chrome.storage.local.get(NOTIFY_KEY))[NOTIFY_KEY] === false) return;
      await chrome.notifications.create(`jr-${key}`, { type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 2 });
    } catch {
      // Windows tắt thông báo của Chrome, hoặc không có quyền: bỏ qua, badge + side panel vẫn báo.
    }
  }

  async function onNotificationClicked(id) {
    if (!String(id).startsWith("jr-") || sunoTabId === null) return;
    try {
      const tab = await chrome.tabs.update(sunoTabId, { active: true });
      await raiseWindow(tab.windowId);
    } catch {
      // tab Suno đã đóng
    }
  }

  // Ảnh hàng chờ từ cầu nối: đếm việc còn lại cho icon, và báo "Xong" khi một tập vừa chạy hết.
  let remainingJobs = 0;
  const episodeOpen = new Map();
  function onQueuePicture(picture) {
    remainingJobs = 0;
    for (const { episode, jobs } of picture.episodes) {
      const open = jobs.some((job) => OPEN_STATUSES.has(job.status));
      remainingJobs += jobs.filter((job) => ["queued", "sent", "running"].includes(job.status)).length;
      const done = jobs.filter((job) => job.status === "done").length;
      const total = jobs.filter((job) => job.status !== "cancelled").length;
      if (episodeOpen.get(episode) === true && !open && done > 0) {
        const failed = total - done;
        void notify(`done-${episode}`, `Xong ${episodeShort(episode)}`, `${done}/${total} việc xong${failed ? ` · ${failed} việc cần xem lại` : ""}.`);
        void logActivity("ok", `Xong cả ${episodeShort(episode)}: ${done}/${total}`);
      }
      episodeOpen.set(episode, open);
    }
    if (state.phase !== "idle") void setStatus("run", state.phase);
  }

  function persistCurrentJob(before) {
    if (state.phase === "idle") {
      currentJobStartedAt = null;
      return chrome.storage.session.set({ [CURRENT_JOB_KEY]: null });
    }
    if (before === "idle" || currentJobStartedAt === null) currentJobStartedAt = Date.now();
    const job = state.job;
    return chrome.storage.session.set({
      [CURRENT_JOB_KEY]: {
        id: job.id,
        kind: job.kind,
        title: jobTitle(job),
        episode: job.episode ?? null,
        slot: job.slot ?? null,
        phase: state.phase,
        startedAt: currentJobStartedAt,
        phaseAt: Date.now()
      }
    });
  }

  function persistPending() {
    // Service worker có thể bị Chrome dừng giữa chừng: giữ lại tab + lượt tải đang chờ để một
    // worker mới vẫn đặt file đúng thư mục (job đó cầu nối đã tự ghi "unknown"), và job gen đã bấm
    // Create vẫn báo được id bài mới cho cầu nối.
    return chrome.storage.session.set({ [PENDING_KEY]: { sunoTabId, expecting, generate: orphanOf(state), orphan } });
  }

  // ── cầu nối ───────────────────────────────────────────────────────────────────────────────

  // Mỗi lần nối có trạng thái bắt tay riêng. Chỉ khi `authenticated` (cầu nối đã chứng minh biết mã
  // VÀ đã gửi welcome) mới gửi nhịp tim/kết quả và mới làm theo job/cancel.
  let link = null; // { ws, token, nonce, verified, authenticated }

  /** Gửi nếu đang nối và đã xác thực; trả false khi không gửi được (để bên gọi tự nhớ việc cần báo). */
  const linkReady = () => Boolean(link?.authenticated && socket?.readyState === OPEN);

  function send(message) {
    if (!linkReady()) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs(attempt++));
  }

  // Một lần nối tại một thời điểm: báo thức, side panel, onStartup có thể gọi cùng lúc — trước đây mỗi lời gọi
  // lọt qua bước kiểm (nằm trước `await`) và mở thêm socket; socket thừa đóng lại thì phá job của socket thật.
  let connecting = null;
  function connect() {
    if (!connecting) connecting = openSocket().finally(() => { connecting = null; });
    return connecting;
  }

  async function openSocket() {
    if (socket && socket.readyState <= OPEN) return;
    const { pairingToken, bridgeUrl } = await chrome.storage.local.get(["pairingToken", "bridgeUrl"]);
    const stopWanted = (await chrome.storage.session.get(STOP_WANTED_KEY))[STOP_WANTED_KEY] === true;
    if (socket && socket.readyState <= OPEN) return;
    if (!pairingToken) {
      await setStatus("key", "Chưa có mã kết nối.");
      return;
    }
    let ws;
    try {
      ws = new WebSocketImpl(bridgeUrl || DEFAULT_BRIDGE_URL);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    link = { ws, token: pairingToken, nonce: randomNonce(), verified: false, authenticated: false, stopWanted };
    const mine = link;
    ws.onopen = () => {
      if (socket !== ws) return ws.close(); // đã có socket khác thay chỗ
      attempt = 0;
      ws.send(JSON.stringify(helloMessage(mine.nonce, version, mine.stopWanted)));
      mine.heartbeat = setIntervalFn(() => send({ type: "heartbeat", phase: state.phase }), HEARTBEAT_MS);
    };
    ws.onmessage = (event) => onBridgeMessage(mine, event.data);
    ws.onclose = () => {
      clearIntervalFn(mine.heartbeat);
      // Socket cũ/thừa đóng muộn: không phải kết nối đang dùng — không đụng job, không nối lại.
      if (socket !== ws) return;
      socket = null;
      if (link === mine) link = null;
      // Cầu nối tự ghi job đang dở là "unknown"; ở đây chỉ dừng tay, không làm tiếp một mình.
      if (state.phase !== "idle") abortLocally();
      if (mine.authenticated) void logActivity("warn", "Mất kết nối cầu nối — đang nối lại");
      void setStatus("off", "Mất kết nối cầu nối — đang nối lại.");
      scheduleReconnect();
    };
  }

  async function onChallenge(mine, message) {
    if (mine.verified) return;
    const expected = await hmacHex(mine.token, bridgeProofInput(mine.nonce, message.nonce));
    if (!sameHex(expected, message.proof)) {
      // Bên kia không biết mã: không phải cầu nối của mình. Không gửi gì, đóng luôn.
      await chrome.storage.session.set({ lastBridgeError: "Cầu nối đang chạy dùng mã khác — sao chép lại cấu hình ở Cài đặt rồi mở lại trợ lý AI." });
      mine.ws.close();
      return;
    }
    mine.verified = true;
    mine.ws.send(JSON.stringify(authMessage(await hmacHex(mine.token, extensionProofInput(message.nonce, mine.nonce)))));
  }

  async function onBridgeMessage(mine, raw) {
    const parsed = parseIncoming(raw);
    if (!parsed.ok || link !== mine) return;
    const message = parsed.message;
    if (message.type === "error") await chrome.storage.session.set({ lastBridgeError: message.message });
    else if (message.type === "close") mine.ws.close();
    else if (message.type === "reload") {
      if (mine.authenticated) await selfReload();
    }
    else if (message.type === "queue") {
      // Chỉ để side panel vẽ tiến độ cả tập; không bao giờ điều khiển bộ máy trạng thái.
      if (mine.authenticated) {
        await chrome.storage.session.set({ [STORAGE.queue]: { ...message, receivedAt: Date.now() } });
        onQueuePicture(message);
      }
    }
    else if (message.type === "challenge") await onChallenge(mine, message);
    else if (message.type === "welcome") {
      if (!mine.verified) return mine.ws.close();
      mine.authenticated = true;
      if (mine.stopWanted) void chrome.storage.session.set({ [STOP_WANTED_KEY]: false }); // cầu nối đã tạm dừng hàng chờ
      await setStatus("on", `Cầu nối ${version}`);
      void logActivity("ok", "Đã kết nối cầu nối");
      if (message.bridgePath) void chrome.storage.local.set({ bridgePath: message.bridgePath });
      void chrome.storage.session.set({ bridgeVersion: message.bridgeVersion ?? null });
      if (orphan) {
        send({ type: "orphan", ...orphan });
        orphan = null;
        await persistPending();
      }
    } else if (mine.authenticated) dispatch(message);
  }

  // ── bộ máy trạng thái ─────────────────────────────────────────────────────────────────────

  function clearTimers() {
    for (const timer of timers.values()) clearTimeoutFn(timer);
    timers.clear();
  }

  function stopContent() {
    currentCommandId = null;
    if (sunoTabId !== null) void chrome.tabs.sendMessage(sunoTabId, { type: "jr.command", command: "stop" }).catch(() => {});
  }

  function abortLocally() {
    clearTimers();
    pendingCommand = null;
    orphan = orphanOf(state) ?? orphan;
    state = IDLE;
    stopContent();
    void persistPending();
    void persistCurrentJob("aborted"); // state đã về idle → xoá thẻ "việc đang chạy" khỏi side panel
  }

  function dispatch(event) {
    const before = state.phase;
    const out = step(state, event);
    state = out.state;
    if (state.phase !== before) heldPhase = null;
    if (state.phase === "idle") {
      clearTimers();
      pendingCommand = null;
      expecting = null;
      // Hết giờ / lỗi / xong: bộ lái đang chạy dở (nếu có) phải dừng, không được lấn sang job sau.
      if (before !== "idle") stopContent();
      if (reloadWanted && before !== "idle") void selfReload();
    }
    void persistPending();
    void persistCurrentJob(before);
    if (before === "idle" && state.phase !== "idle") {
      lastJob = { id: state.job.id, title: jobTitle(state.job) };
      void logActivity("info", `Nhận việc: ${lastJob.title}`);
    }
    else if (state.phase !== before && state.phase !== "idle") void logActivity("info", phaseLabel(state.phase));
    void setStatus(state.phase === "idle" ? (link?.authenticated ? "on" : "off") : "run", state.phase);
    for (const action of out.actions) void execute(action);
  }

  // DỪNG NGAY từ side panel. Chưa bấm Create → dừng bộ lái, việc thành "cần bạn", cầu nối tạm dừng
  // hàng chờ (alert user_stop). Đã bấm Create → KHÔNG cắt ngang (id bài mới phải về được, tránh tiêu
  // credit hai lần): chỉ tạm dừng hàng chờ để không nhận việc mới.
  function userStop() {
    if (state.phase !== "idle" && !AFTER_SPEND.has(state.phase)) {
      dispatch({ type: "human_needed", reason: "user_stop" });
      return { stopped: true };
    }
    if (!send({ type: "alert", kind: "user_stop" })) void chrome.storage.session.set({ [STOP_WANTED_KEY]: true });
    const spending = state.phase === "extracting" ? "Suno đang tách stem (đã trừ credit)" : "Đã bấm Create";
    void logActivity("warn", state.phase === "idle" ? "Đã tạm dừng hàng chờ" : `${spending} — để việc này chạy xong, hàng chờ đã tạm dừng`);
    return { stopped: state.phase === "idle", finishing: state.phase !== "idle" };
  }

  /**
   * Cầu nối (mới hơn) bảo nạp lại: chỉ khi rảnh hẳn — không job, không lượt tải đang chờ — và không vừa nạp trong
   * 10 phút. Nạp lại = Chrome đọc lại code extension từ ổ đĩa rồi tự nối về cầu nối trong vài giây.
   */
  async function selfReload() {
    if (state.phase !== "idle" || expecting) {
      reloadWanted = true;
      return logActivity("info", "Có bản mới — sẽ tự cập nhật khi xong việc đang chạy");
    }
    reloadWanted = false;
    const last = (await chrome.storage.local.get(SELF_RELOAD_KEY))[SELF_RELOAD_KEY];
    if (typeof last === "number" && Date.now() - last < SELF_RELOAD_GAP_MS) return undefined;
    await chrome.storage.local.set({ [SELF_RELOAD_KEY]: Date.now() });
    await logActivity("ok", "Có bản mới trên máy — tự cập nhật extension");
    chrome.runtime.reload();
    return undefined;
  }

  // "Chạy tiếp" từ side panel sau khi chủ kênh đã xử lý (đưa cửa sổ Suno lên, giải ô xác nhận…). Cầu nối quyết
  // việc nào chạy lại được an toàn (chưa export / chưa bấm Create); việc còn lại vẫn chờ trợ lý AI.
  function userResume() {
    if (!link?.authenticated) {
      void connect(); // thử nối lại ngay; chủ kênh bấm lại khi đã nối
      return { sent: false };
    }
    send({ type: "control", action: "resume" });
    void logActivity("info", "Bạn đã bảo chạy tiếp");
    if (state.phase === "idle") void setStatus("on", "");
    return { sent: true };
  }

  function onUiMessage(message, sender, sendResponse) {
    if (message?.type !== "jr.ui" || sender.id !== chrome.runtime.id) return undefined;
    // Chỉ trang của chính extension (side panel/options) — content script trên suno.com bị loại.
    if (!String(sender.url ?? "").startsWith(`chrome-extension://${chrome.runtime.id}/`)) return undefined;
    if (message.action === "stop") sendResponse(userStop());
    else if (message.action === "resume") sendResponse(userResume());
    else if (message.action === "connect") {
      // Mở side panel = chủ kênh đang nhìn: nối lại ngay, không đợi báo thức 1 phút.
      if (!link?.authenticated) void connect();
      sendResponse({ connecting: !link?.authenticated });
    }
    else if (message.action === "clear_log") {
      // Xoá đi chung hàng ghi của logActivity để không giẫm lên dòng nhật ký đang ghi dở.
      activityWrite = activityWrite.then(() => chrome.storage.local.set({ [ACTIVITY_KEY]: [] })).catch(() => {});
      sendResponse({ cleared: true });
    } else sendResponse({ error: "unknown_action" });
    return undefined;
  }

  async function execute(action) {
    switch (action.type) {
      case "navigate":
        return navigate(action.url, action.then, action.payload);
      case "await_load":
        // Đặt TRƯỚC lệnh content bấm nút điều hướng (cùng lượt actions, đồng bộ): lần nạp xong kế tiếp nhận lệnh `then`.
        pendingCommand = sunoTabId === null ? null : { tabId: sunoTabId, command: action.then, payload: action.payload ?? null };
        return persistPending();
      case "content":
        // Bấm Extract (50 credit) chỉ khi tin "extracting" vừa đi được tới cầu nối (runner gửi nó ngay trước lệnh này):
        // mất kết nối thì dừng TRƯỚC cú bấm, để lần chạy lại không bao giờ là lần bấm thứ hai mà cầu nối không biết.
        if (action.command === "extract_stems" && !linkReady()) {
          return dispatch({ type: "content_error", step: "extract_stems", reason: "bridge_lost" });
        }
        return command(action.command, action.payload);
      case "check_clip":
        return setTimeoutFn(() => checkClip(action.id), action.afterMs ?? 0);
      case "expect_download":
        expecting = { episode: action.episode, exportId: action.exportId, title: action.title ?? null, format: action.format ?? "wav", downloadId: null };
        return persistPending();
      case "timeout":
        clearTimeoutFn(timers.get(action.phase));
        timers.set(action.phase, setTimeoutFn(() => {
          if (heldPhase !== action.phase) dispatch({ type: "timeout", phase: action.phase });
        }, action.ms));
        return undefined;
      case "report":
        if (action.message.type === "alert") {
          await setStatus("human", action.message.kind);
          void logActivity("warn", `Cần bạn xử lý: ${humanReason(action.message.kind)}`);
          void notify("human", `Cần bạn: ${humanReason(action.message.kind)}`, humanNextStep(action.message.kind));
        } else if (action.message.type === "result") {
          const status = action.message.status;
          const note = status === "done" ? "Xong" : status === "needs_human" ? "Dừng, cần bạn" : `Lỗi (${action.message.reason ?? "không rõ"})`;
          const title = lastJob?.id === action.message.jobId ? lastJob.title : action.message.jobId;
          void logActivity(status === "done" ? "ok" : "warn", `${note}: ${title}`);
        }
        return send(action.message);
      default:
        return undefined;
    }
  }

  async function sunoTabAlive() {
    if (sunoTabId === null) return false;
    try {
      await chrome.tabs.get(sunoTabId);
      return true;
    } catch {
      return false;
    }
  }

  async function navigate(url, then, payload = null) {
    // MỘT tab Suno riêng, luôn ở trước: waveform Studio chỉ nạp khi tab ở foreground.
    let tab;
    try {
      tab = (await sunoTabAlive()) ? await chrome.tabs.update(sunoTabId, { url, active: true }) : await chrome.tabs.create({ url, active: true });
    } catch {
      // Tab bị đóng giữa lúc kiểm và lúc điều hướng: báo ngay, không chờ hết giờ.
      sunoTabId = null;
      return dispatch({ type: "human_needed", reason: "tab_closed" });
    }
    sunoTabId = tab.id;
    pendingCommand = then ? { tabId: sunoTabId, command: then, payload } : null;
    await persistPending();
    await raiseWindow(tab.windowId);
  }

  /**
   * Đưa cửa sổ của tab Suno lên trước. Trên Windows, cửa sổ bị che/thu nhỏ khiến trang "ẩn" và
   * Chrome hãm hẹn giờ (đo 27/09: 1 nhịp/phút) — job sẽ dừng với tab_hidden. Không đưa được thì để
   * content script báo tab_hidden, chủ kênh tự mở cửa sổ.
   */
  async function raiseWindow(windowId) {
    if (!Number.isInteger(windowId) || !chrome.windows?.update) return;
    try {
      // Windows hay chặn cướp focus: thêm nháy thanh tác vụ; chỉ bung cửa sổ đang thu nhỏ (không đụng cỡ cửa sổ khác).
      let current = null;
      try {
        current = await chrome.windows.get(windowId);
      } catch {
        current = null; // không đọc được trạng thái: vẫn đưa lên như cũ
      }
      const update = { focused: true, drawAttention: true, ...(current?.state === "minimized" ? { state: "normal" } : {}) };
      await chrome.windows.update(windowId, update);
    } catch (error) {
      await chrome.storage.session.set({ lastWindowError: String(error?.message ?? error).slice(0, 120) });
    }
  }

  async function command(name, payload = null) {
    if (sunoTabId === null) return dispatch({ type: "content_error", step: name });
    currentCommandId = ++commandSeq;
    try {
      await chrome.tabs.sendMessage(sunoTabId, { type: "jr.command", command: name, job: payload, commandId: currentCommandId });
    } catch {
      if (name !== "stop") dispatch({ type: "content_error", step: name });
    }
    return undefined;
  }

  async function checkClip(id) {
    try {
      const signal = globalThis.AbortSignal?.timeout ? AbortSignal.timeout(CLIP_FETCH_TIMEOUT_MS) : undefined;
      const response = await fetchFn(CLIP_ENDPOINT + id, { credentials: "omit", cache: "no-store", signal });
      const data = response.ok ? await response.json() : {};
      const seconds = data?.metadata?.duration;
      const own = data?.id === id;
      dispatch({
        type: "clip_status",
        id,
        status: own ? data.status : "unavailable",
        seconds: typeof seconds === "number" ? seconds : null,
        title: own && typeof data.title === "string" ? data.title.slice(0, 300) : undefined
      });
    } catch {
      dispatch({ type: "clip_status", id, status: "unavailable", seconds: null });
    }
  }

  // ── listener ──────────────────────────────────────────────────────────────────────────────

  function onTabUpdated(tabId, changeInfo) {
    if (changeInfo.status !== "complete" || !pendingCommand || pendingCommand.tabId !== tabId) return;
    const { command: next, payload } = pendingCommand;
    pendingCommand = null;
    void command(next, payload);
  }

  function onTabRemoved(tabId) {
    if (tabId !== sunoTabId) return;
    sunoTabId = null;
    void persistPending();
    if (state.phase !== "idle") dispatch({ type: "human_needed", reason: "tab_closed" });
  }

  function onContentMessage(message, sender) {
    // Chỉ nhận sự kiện từ content script của CHÍNH tab Suno đang chạy job.
    if (message?.type !== "jr.content" || sender.id !== chrome.runtime.id) return;
    if (sender.tab?.id !== sunoTabId || !String(sender.url ?? "").startsWith("https://suno.com/")) return;
    const event = message.event;
    if (!event || !CONTENT_EVENTS.has(event.type)) return;
    if (currentCommandId === null || event.commandId !== currentCommandId) return;
    if (event.type === "hidden") return onSunoHidden(event.hidden === true);
    dispatch({
      type: event.type,
      step: String(event.step ?? "").slice(0, 40),
      exportId: event.exportId,
      reason: event.reason,
      // Job gen: form đọc lại, trường lệch, id bài mới — runner tự kiểm kiểu trước khi dùng.
      observed: plainObject(event.observed),
      mismatches: Array.isArray(event.mismatches) ? event.mismatches : undefined,
      clipIds: Array.isArray(event.clipIds) ? event.clipIds : undefined,
      stems: Array.isArray(event.stems) ? event.stems : undefined,
      hasStems: event.hasStems === true,
      hint: pageHintOf(event.hint)
    });
  }

  /**
   * Tab Suno bị che: bộ lái đứng chờ tại chỗ (không làm gì trên Suno), ở đây treo hẹn giờ của bước và báo chủ kênh.
   * Cửa sổ hiện lại: đặt lại hẹn giờ đủ thời gian của bước, chạy tiếp. Cầu nối không bị bảo dừng hàng chờ.
   */
  function onSunoHidden(hidden) {
    if (state.phase === "idle") return;
    if (hidden) {
      if (heldPhase === state.phase) return;
      heldPhase = state.phase;
      clearTimeoutFn(timers.get(heldPhase));
      timers.delete(heldPhase);
      void setStatus("human", "tab_hidden_wait");
      void logActivity("warn", "Cửa sổ Suno bị che — đang chờ hiện lại để chạy tiếp");
      void notify("hidden", "Cửa sổ Suno đang bị che", humanNextStep("tab_hidden_wait"));
      return;
    }
    if (heldPhase === null) return;
    const phase = heldPhase;
    heldPhase = null;
    if (state.phase === phase) void execute({ type: "timeout", phase, ms: STEP_TIMEOUT_MS[phase] });
    void setStatus("run", state.phase);
    void logActivity("info", "Cửa sổ Suno hiện lại — chạy tiếp");
  }

  function onDeterminingFilename(item, suggest) {
    if (!expecting || expecting.downloadId !== null || !downloadBelongsTo(item, expecting)) return;
    expecting = { ...expecting, downloadId: item.id };
    void persistPending();
    suggest({ filename: downloadTarget(expecting.episode, item.filename), conflictAction: "uniquify" });
  }

  async function onDownloadChanged(delta) {
    if (!expecting || delta.id !== expecting.downloadId || !delta.state) return;
    const [item] = await chrome.downloads.search({ id: delta.id });
    // Worker mới (khôi phục từ storage.session) không còn job: lượt tải này mồ côi.
    const orphanDownload = state.phase === "idle";
    if (delta.state.current === "interrupted") {
      dispatch({ type: "download_failed", error: item?.error ?? "interrupted" });
    } else if (delta.state.current === "complete") {
      const filename = basename(item?.filename);
      const zip = expecting.format === "zip";
      if (zip ? isZip(filename, item?.mime) : isWav(filename, item?.mime)) dispatch({ type: "download_complete", filename, path: item.filename });
      else dispatch({ type: "download_failed", error: zip ? "not_zip" : "not_wav" });
    } else {
      return;
    }
    if (orphanDownload) {
      // Chỉ ghi lại để chủ kênh thấy; file vẫn nằm đúng JR-Suno/<EP>/ để ingest.
      await chrome.storage.session.set({ lastOrphanDownload: basename(item?.filename) });
      expecting = null;
      await persistPending();
      if (reloadWanted) void selfReload();
    }
  }

  async function start() {
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    chrome.runtime.onMessage.addListener(onContentMessage);
    chrome.runtime.onMessage.addListener(onUiMessage);
    chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
    chrome.downloads.onChanged.addListener((delta) => void onDownloadChanged(delta));
    chrome.alarms.create("reconnect", { periodInMinutes: 0.5 }); // mức tối thiểu Chrome cho phép
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "reconnect") void connect();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.pairingToken || changes.bridgeUrl)) {
        socket?.close();
        attempt = 0;
        void connect();
      }
    });
    chrome.notifications?.onClicked?.addListener((id) => void onNotificationClicked(id));
    chrome.runtime.onStartup.addListener(() => void connect());
    chrome.runtime.onInstalled.addListener(() => void connect());
    const saved = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
    if (saved) {
      sunoTabId = saved.sunoTabId ?? null;
      expecting = saved.expecting ?? null;
      // Worker trước chết giữa job gen đã bấm Create → báo cầu nối sau lần xác thực tới.
      orphan = saved.orphan ?? saved.generate ?? null;
    }
    await connect();
  }

  return {
    start,
    snapshot: () => ({ phase: state.phase, sunoTabId, expecting })
  };
}
