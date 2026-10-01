import test from "node:test";
import assert from "node:assert/strict";
import { createController } from "../lib/controller.js";
import { STEP_TIMEOUT_MS } from "../lib/runner.js";
import { bridgeProofInput, extensionProofInput, hmacHex } from "../lib/protocol.js";

// Bộ điều khiển của service worker với chrome.* + WebSocket + hẹn giờ GIẢ: kiểm đúng các chỗ dễ
// hỏng — nối lại, lệnh sau điều hướng, người gửi tin nhắn, gán lượt tải cho đúng bản export.

const CANDIDATE = "11111111-1111-4111-8111-111111111111";
const EXPORT = "22222222-2222-4222-8222-222222222222";
const JOB = {
  id: `EP006.01.${CANDIDATE}`,
  kind: "export_download",
  episode: "EP006-deep-autumn-post-town-inn",
  slot: 1,
  candidateId: CANDIDATE,
  expectedTitle: "雨夜の宿口",
  minSeconds: 320
};
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const TAB_ID = 42;

function listener() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...args) => fns.map((fn) => fn(...args)), fns };
}

function fakeWorld({ token = "paired" } = {}) {
  const local = token ? { pairingToken: token } : {};
  const session = {};
  const sentToTab = [];
  const sockets = [];
  const timers = [];
  const downloads = new Map();
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      reloaded: 0,
      reload: () => { chrome.runtime.reloaded += 1; },
      getManifest: () => ({ version: "0.1.0" }),
      onMessage: listener(),
      onStartup: listener(),
      onInstalled: listener()
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([keys].flat().filter((k) => k in local).map((k) => [k, local[k]])),
        set: async (value) => Object.assign(local, value)
      },
      session: {
        get: async (keys) => Object.fromEntries([keys].flat().filter((k) => k in session).map((k) => [k, session[k]])),
        set: async (value) => Object.assign(session, value)
      },
      onChanged: listener()
    },
    action: { badge: [], setBadgeText: async ({ text }) => chrome.action.badge.push(text), setBadgeBackgroundColor: async () => {} },
    notifications: {
      shown: [],
      create: async (id, options) => chrome.notifications.shown.push({ id, ...options }),
      onClicked: listener()
    },
    tabs: {
      created: [],
      updated: [],
      create: async (props) => {
        chrome.tabs.created.push(props);
        return { id: TAB_ID, windowId: 7 };
      },
      update: async (id, props) => {
        chrome.tabs.updated.push({ id, ...props });
        return { id, windowId: 7 };
      },
      get: async (id) => {
        if (id !== TAB_ID) throw new Error("no tab");
        return { id };
      },
      sendMessage: async (id, message) => sentToTab.push({ id, ...message }),
      onUpdated: listener(),
      onRemoved: listener()
    },
    downloads: {
      onDeterminingFilename: listener(),
      onChanged: listener(),
      search: async ({ id }) => [downloads.get(id)].filter(Boolean)
    },
    alarms: { create: () => {}, onAlarm: listener() },
    windows: {
      focused: [],
      state: "normal",
      get: async (id) => ({ id, state: chrome.windows.state }),
      update: async (id, props) => chrome.windows.focused.push({ id, ...props })
    }
  };
  class FakeSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    receive(message) {
      return this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  const setTimeoutFn = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  const controller = createController({
    chrome,
    WebSocketImpl: FakeSocket,
    setTimeoutFn,
    clearTimeoutFn: () => {},
    setIntervalFn: (fn, ms) => {
      timers.push({ fn, ms, interval: true });
      return timers.length;
    },
    clearIntervalFn: () => {},
    fetchFn: async () => ({ ok: true, json: async () => ({ id: EXPORT, status: "complete", metadata: { duration: 327.9 } }) })
  });
  return { chrome, controller, sockets, sentToTab, timers, session, local, downloads };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const SERVER_NONCE = "ab".repeat(32);

/** Đóng vai cầu nối đúng: trả challenge có bằng chứng từ mã "paired", kiểm auth, rồi welcome. */
async function connected(world, token = "paired") {
  await world.controller.start();
  const ws = world.sockets.at(-1);
  ws.open();
  const hello = ws.sent[0];
  await ws.receive({ type: "challenge", nonce: SERVER_NONCE, proof: await hmacHex(token, bridgeProofInput(hello.nonce, SERVER_NONCE)) });
  const auth = ws.sent.at(-1);
  assert.equal(auth.type, "auth");
  assert.equal(auth.proof, await hmacHex(token, extensionProofInput(SERVER_NONCE, hello.nonce)));
  await ws.receive({ type: "welcome" });
  return ws;
}

/** Content script trả lời lệnh gần nhất (mang đúng commandId như content.js thật). */
function fromContent(world, event, tabId = TAB_ID, url = "https://suno.com/studio") {
  const last = world.sentToTab.filter((m) => m.command !== "stop").at(-1);
  const commandId = "commandId" in event ? event.commandId : last?.commandId;
  world.chrome.runtime.onMessage.fire({ type: "jr.content", event: { ...event, commandId } }, { id: EXTENSION_ID, tab: { id: tabId }, url });
}

async function runToDownloading(world, ws) {
  await ws.receive({ type: "job", job: JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  fromContent(world, { type: "content_done", step: "studio_ready" });
  fromContent(world, { type: "content_done", step: "exported", exportId: EXPORT });
  await flush();
  const clipCheck = world.timers.find((t) => !t.interval && t.ms === 0);
  await clipCheck.fn();
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  fromContent(world, { type: "content_done", step: "song_ready", }, TAB_ID, `https://suno.com/song/${EXPORT}`);
  await flush();
}

test("chưa có mã ghép cặp → không mở socket", async () => {
  const world = fakeWorld({ token: null });
  await world.controller.start();
  assert.equal(world.sockets.length, 0);
});

test("mở socket → gửi hello kèm mã; nhịp tim gửi heartbeat{phase}", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  assert.deepEqual(Object.keys(ws.sent[0]).sort(), ["nonce", "protocol", "type", "version"]);
  assert.match(ws.sent[0].nonce, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(ws.sent).includes("paired"), false, "mã ghép cặp không bao giờ đi qua socket");
  world.timers.find((t) => t.interval).fn();
  assert.deepEqual(ws.sent.at(-1), { type: "heartbeat", phase: "idle" });
});

test("job → mở 1 tab Suno ở trước; lệnh content chỉ gửi SAU khi tab tải xong", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  assert.deepEqual(world.chrome.tabs.created[0], { url: `https://suno.com/studio?for_clip_id=${CANDIDATE}&create_new=1`, active: true });
  assert.deepEqual(world.chrome.windows.focused, [{ id: 7, focused: true, drawAttention: true }], "cửa sổ Suno lên trước (tab ẩn bị Chrome hãm)");
  assert.equal(world.sentToTab.length, 0);
  world.chrome.tabs.onUpdated.fire(999, { status: "complete" });
  assert.equal(world.sentToTab.length, 0, "tab khác tải xong không tính");
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  assert.equal(world.sentToTab.at(-1).command, "wait_studio_ready");
});

test("tin nhắn content từ tab lạ / trang ngoài Suno bị bỏ qua", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  const before = world.sentToTab.length;
  fromContent(world, { type: "content_done", step: "studio_ready" }, 7);
  fromContent(world, { type: "content_done", step: "studio_ready" }, TAB_ID, "https://evil.com/");
  await flush();
  assert.equal(world.sentToTab.length, before);
  fromContent(world, { type: "content_done", step: "studio_ready" });
  await flush();
  assert.equal(world.sentToTab.at(-1).command, "export_full_song");
});

test("lượt tải: bài Suno khác tải tay cùng lúc KHÔNG bị gán; đúng bản export thì vào JR-Suno/<EP>/ và báo done", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await runToDownloading(world, ws);
  assert.equal(world.sentToTab.at(-1).command, "download_wav");

  const suggestions = [];
  world.chrome.downloads.onDeterminingFilename.fire(
    { id: 5, url: "https://cdn1.suno.ai/other.wav", referrer: "https://suno.com/song/other", filename: "khác.wav" },
    (s) => suggestions.push(s)
  );
  assert.equal(suggestions.length, 0);

  // Đúng hình dạng đo 27/09: blob ngẫu nhiên, referrer rỗng — chỉ tên file (= tiêu đề) nhận ra bài.
  world.chrome.downloads.onDeterminingFilename.fire(
    { id: 6, url: "blob:https://suno.com/ff91b3ce-0bec-496c-bf4c-296962ac83f2", referrer: "", filename: "EP006.01. 雨夜の宿口.wav" },
    (s) => suggestions.push(s)
  );
  assert.deepEqual(suggestions, [{ filename: "JR-Suno/EP006/EP006.01. 雨夜の宿口.wav", conflictAction: "uniquify" }]);

  world.downloads.set(6, { id: 6, filename: "C:\\Users\\x\\Downloads\\JR-Suno\\EP006\\EP006.01. 雨夜の宿口.wav", mime: "audio/wav" });
  await world.chrome.downloads.onChanged.fns[0]({ id: 6, state: { current: "complete" } });
  const result = ws.sent.at(-1);
  assert.equal(result.type, "result");
  assert.equal(result.status, "done");
  assert.equal(result.exportId, EXPORT);
  assert.equal(result.filename, "EP006.01. 雨夜の宿口.wav");
});

test("lượt tải đang chờ được lưu vào storage.session (sống qua service worker khởi động lại)", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await runToDownloading(world, ws);
  assert.deepEqual(world.session.jrPending, { sunoTabId: TAB_ID, expecting: { episode: JOB.episode, exportId: EXPORT, title: JOB.expectedTitle, format: "wav", downloadId: null }, generate: null, orphan: null });
});

test("service worker mới: khôi phục lượt tải đang chờ, file vẫn vào đúng thư mục", async () => {
  const world = fakeWorld();
  world.session.jrPending = { sunoTabId: TAB_ID, expecting: { episode: JOB.episode, exportId: EXPORT, downloadId: null } };
  await world.controller.start();
  const suggestions = [];
  world.chrome.downloads.onDeterminingFilename.fire(
    { id: 9, url: `https://cdn1.suno.ai/${EXPORT}.wav`, filename: "EP006.01. 雨夜の宿口.wav" },
    (s) => suggestions.push(s)
  );
  assert.equal(suggestions[0].filename, "JR-Suno/EP006/EP006.01. 雨夜の宿口.wav");
});

test("mất kết nối giữa job → dừng tay (lệnh stop), hẹn nối lại, không tự làm tiếp", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  ws.close();
  await flush();
  assert.equal(world.sentToTab.at(-1).command, "stop");
  assert.ok(world.timers.some((t) => !t.interval && t.ms === 500), "hẹn nối lại sau 0,5 s");
  assert.equal(world.controller.snapshot().phase, "idle");
});

test("tin nhắn cầu nối sai định dạng bị bỏ qua, không ném lỗi", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: { ...JOB, candidateId: "../x" } });
  await ws.onmessage({ data: "not json" });
  assert.equal(world.controller.snapshot().phase, "idle");
});

test("job gen (dry-run): packet tới content sau khi trang Create tải xong; khối đọc lại form về cầu nối", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  const packet = { title: "EP012.01. 梅の里の朝", styles: "koto", exclude: "vocals", lyrics: "", model: "v6", tab: "advanced", durationSeconds: 330, maxMode: true, variety: 1, weirdness: 30, styleInfluence: 85, vocalGender: null, myTaste: false };
  const job = { id: "EP012.01.B01v2", kind: "generate", episode: "EP012-early-spring-plum-orchard", slot: 1, batchId: "B01v2", dryRun: true, minSeconds: 320, packet };
  await ws.receive({ type: "job", job });
  await flush();
  assert.deepEqual(world.chrome.tabs.created[0], { url: "https://suno.com/create", active: true });
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  const { commandId, ...sent } = world.sentToTab.at(-1);
  assert.deepEqual(sent, { id: TAB_ID, type: "jr.command", command: "fill_create_form", job: { packet } });
  assert.ok(Number.isInteger(commandId));
  const observed = { model: "v6", max_mode: true, styles_char_count: 4, nested: { no: 1 } };
  fromContent(world, { type: "content_done", step: "form_ready", observed, mismatches: [] }, TAB_ID, "https://suno.com/create");
  await flush();
  const result = ws.sent.at(-1);
  assert.equal(result.type, "result");
  assert.equal(result.status, "done");
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.observed, { model: "v6", max_mode: true, styles_char_count: 4 }, "chỉ giữ giá trị nguyên thuỷ");
  assert.equal(world.sentToTab.some((m) => m.command === "submit_create"), false);
});

test("kẻ chiếm cổng (không biết mã): không nhận được mã, job của nó bị bỏ qua, extension tự đóng", async () => {
  const world = fakeWorld();
  await world.controller.start();
  const ws = world.sockets.at(-1);
  ws.open();
  await ws.receive({ type: "job", job: JOB });
  await ws.receive({ type: "welcome" });
  await ws.receive({ type: "job", job: JOB });
  await flush();
  assert.equal(world.chrome.tabs.created.length, 0, "không mở tab, không làm theo job");
  await ws.receive({ type: "challenge", nonce: SERVER_NONCE, proof: "00".repeat(32) });
  assert.equal(ws.readyState, 3, "bằng chứng sai → đóng");
  assert.equal(ws.sent.some((m) => m.type === "auth"), false, "không gửi bằng chứng của mình cho kẻ lạ");
  assert.equal(JSON.stringify(ws.sent).includes("paired"), false);
});

test("welcome trước khi cầu nối chứng minh biết mã → đóng, không bật ON", async () => {
  const world = fakeWorld();
  await world.controller.start();
  const ws = world.sockets.at(-1);
  ws.open();
  await ws.receive({ type: "welcome" });
  assert.equal(ws.readyState, 3);
});

const GEN_PACKET = { title: "EP012.01. 梅の里の朝", styles: "koto", exclude: "vocals", lyrics: "", model: "v6", tab: "advanced", durationSeconds: 330, maxMode: true, variety: 1, weirdness: 30, styleInfluence: 85, vocalGender: null, myTaste: false };
const GEN_JOB = { id: "EP012.01.B01v2", kind: "generate", episode: "EP012-early-spring-plum-orchard", slot: 1, batchId: "B01v2", dryRun: false, minSeconds: 320, packet: GEN_PACKET };
const CLIP_A = "33333333-3333-4333-8333-333333333333";

async function runToRendering(world, ws) {
  await ws.receive({ type: "job", job: GEN_JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  fromContent(world, { type: "content_done", step: "form_ready", observed: { max_mode: true }, mismatches: [] }, TAB_ID, "https://suno.com/create");
  await flush();
  fromContent(world, { type: "content_done", step: "submitted", clipIds: [CLIP_A] }, TAB_ID, "https://suno.com/create");
  await flush();
}

test("báo cáo trễ của lệnh cũ (commandId khác) bị bỏ qua", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  const current = world.sentToTab.at(-1).commandId;
  fromContent(world, { type: "content_done", step: "studio_ready", commandId: current - 1 });
  fromContent(world, { type: "content_done", step: "studio_ready", commandId: undefined });
  await flush();
  assert.equal(world.sentToTab.at(-1).command, "wait_studio_ready", "chưa sang bước export");
  fromContent(world, { type: "content_done", step: "studio_ready" });
  await flush();
  assert.equal(world.sentToTab.at(-1).command, "export_full_song");
});

test("hết giờ → ra lệnh stop cho bộ lái đang chạy dở", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  world.timers.find((t) => !t.interval && t.ms > 1000).fn();
  await flush();
  assert.equal(world.sentToTab.at(-1).command, "stop");
  assert.equal(ws.sent.at(-1).reason, "timeout:opening_studio");
});

test("mất kết nối khi job gen đang render → id bài được giữ và gửi 'orphan' sau lần xác thực kế tiếp", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await runToRendering(world, ws);
  ws.close();
  await flush();
  assert.deepEqual(world.session.jrPending.orphan, { jobId: GEN_JOB.id, phase: "rendering", clipIds: [CLIP_A] });
  world.timers.filter((t) => !t.interval).at(-1).fn(); // hẹn nối lại
  await flush();
  const ws2 = world.sockets.at(-1);
  ws2.open();
  const hello = ws2.sent[0];
  await ws2.receive({ type: "challenge", nonce: SERVER_NONCE, proof: await hmacHex("paired", bridgeProofInput(hello.nonce, SERVER_NONCE)) });
  await ws2.receive({ type: "welcome" });
  assert.deepEqual(ws2.sent.at(-1), { type: "orphan", jobId: GEN_JOB.id, phase: "rendering", clipIds: [CLIP_A] });
  assert.equal(world.session.jrPending.orphan, null);
});

test("service worker khởi động lại giữa job gen đã bấm Create → báo 'orphan' khi nối lại", async () => {
  const world = fakeWorld();
  world.session.jrPending = { sunoTabId: TAB_ID, expecting: null, generate: { jobId: GEN_JOB.id, phase: "submitting", clipIds: [] }, orphan: null };
  const ws = await connected(world);
  assert.deepEqual(ws.sent.find((m) => m.type === "orphan"), { type: "orphan", jobId: GEN_JOB.id, phase: "submitting", clipIds: [] });
});

test("tab Suno bị đóng đúng lúc điều hướng → needs_human tab_closed ngay, không chờ hết giờ", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  world.chrome.tabs.create = async () => {
    throw new Error("tab closed");
  };
  await ws.receive({ type: "job", job: JOB });
  await flush();
  const result = ws.sent.filter((m) => m.type === "result").at(-1);
  assert.equal(result.status, "needs_human");
  assert.equal(result.reason, "tab_closed");
});

// ── side panel: DỪNG NGAY + việc đang chạy + nhật ký ────────────────────────────────────────

const PANEL_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;

function fromPanel(world, action, url = PANEL_URL) {
  const replies = [];
  world.chrome.runtime.onMessage.fire({ type: "jr.ui", action }, { id: EXTENSION_ID, url }, (reply) => replies.push(reply));
  return replies;
}

test("DỪNG NGAY khi chưa bấm Create: bộ lái dừng, việc về cầu nối là needs_human user_stop, hàng chờ tạm dừng", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await runToDownloading(world, ws);
  const replies = fromPanel(world, "stop");
  await flush();
  assert.deepEqual(replies, [{ stopped: true }]);
  assert.ok(ws.sent.some((m) => m.type === "alert" && m.kind === "user_stop"), "alert user_stop để cầu nối tạm dừng hàng chờ");
  assert.deepEqual(ws.sent.find((m) => m.type === "result"), { type: "result", jobId: JOB.id, status: "needs_human", exportId: EXPORT, reason: "user_stop" },
    "đã export rồi mới dừng: mang mã bản export để lần sau chỉ tải");
  assert.ok(world.sentToTab.some((m) => m.command === "stop"), "bộ lái nhận lệnh stop");
  assert.equal(world.session.jrCurrentJob, null);
});

test("DỪNG NGAY sau khi đã bấm Create: KHÔNG cắt job (id bài phải về), chỉ tạm dừng hàng chờ", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await runToRendering(world, ws);
  const replies = fromPanel(world, "stop");
  await flush();
  assert.deepEqual(replies, [{ stopped: false, finishing: true }]);
  assert.ok(ws.sent.some((m) => m.type === "alert" && m.kind === "user_stop"));
  assert.equal(ws.sent.some((m) => m.type === "result"), false, "job đang render vẫn chạy tiếp");
  assert.equal(world.session.jrCurrentJob.phase, "rendering");
  assert.equal(world.controller.snapshot().phase, "rendering");
});

test("DỪNG NGAY lúc mất kết nối: lần nối sau lời chào mang stopped để cầu nối tạm dừng trước khi giao việc", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  ws.close();
  await flush();
  const replies = fromPanel(world, "stop");
  await flush();
  assert.deepEqual(replies, [{ stopped: true, finishing: false }]);
  world.timers.filter((t) => !t.interval).at(-1).fn(); // hẹn nối lại
  await flush();
  const ws2 = world.sockets.at(-1);
  ws2.open();
  assert.equal(ws2.sent[0].stopped, true);
  const hello = ws2.sent[0];
  await ws2.receive({ type: "challenge", nonce: SERVER_NONCE, proof: await hmacHex("paired", bridgeProofInput(hello.nonce, SERVER_NONCE)) });
  await ws2.receive({ type: "welcome" });
  await flush();
  ws2.close();
  await flush();
  world.timers.filter((t) => !t.interval).at(-1).fn();
  await flush();
  const ws3 = world.sockets.at(-1);
  ws3.open();
  assert.equal("stopped" in ws3.sent[0], false, "đã báo một lần là đủ");
});

test("lệnh DỪNG giả từ trang Suno (content script) bị bỏ qua", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await runToDownloading(world, ws);
  const replies = fromPanel(world, "stop", "https://suno.com/create");
  await flush();
  assert.deepEqual(replies, []);
  assert.equal(ws.sent.some((m) => m.kind === "user_stop"), false);
  assert.equal(world.controller.snapshot().phase, "downloading");
});

test("side panel đọc được việc đang chạy (tiêu đề, bước) và nhật ký nhận việc/kết nối", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  const job = world.session.jrCurrentJob;
  assert.equal(job.title, JOB.expectedTitle);
  assert.equal(job.kind, "export_download");
  assert.equal(job.phase, "opening_studio");
  assert.ok(job.startedAt > 0 && job.phaseAt >= job.startedAt);
  const texts = world.local.jrActivity.map((e) => e.text);
  assert.ok(texts.includes("Đã kết nối cầu nối"));
  assert.ok(texts.includes(`Nhận việc: ${JOB.expectedTitle}`));
  assert.equal(JSON.stringify(world.local.jrActivity).includes("paired"), false, "nhật ký không chứa mã kết nối");
});

test("DỪNG NGAY khi việc gen đang điền form (chưa bấm Create): dừng hẳn, không có Create nào", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: GEN_JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  assert.equal(world.controller.snapshot().phase, "filling_form");
  assert.deepEqual(fromPanel(world, "stop"), [{ stopped: true }]);
  await flush();
  assert.deepEqual(ws.sent.find((m) => m.type === "result"), { type: "result", jobId: GEN_JOB.id, status: "needs_human", reason: "user_stop" });
  assert.equal(world.sentToTab.some((m) => m.command === "submit_create"), false, "không bao giờ bấm Create sau khi đã dừng");
});

test("DỪNG NGAY đúng lúc đang bấm Create (submitting): không cắt job, id bài về sau vẫn được ghi", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: GEN_JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  fromContent(world, { type: "content_done", step: "form_ready", observed: { max_mode: true }, mismatches: [] }, TAB_ID, "https://suno.com/create");
  await flush();
  assert.equal(world.controller.snapshot().phase, "submitting");
  assert.deepEqual(fromPanel(world, "stop"), [{ stopped: false, finishing: true }]);
  await flush();
  assert.equal(ws.sent.some((m) => m.type === "result"), false);
  fromContent(world, { type: "content_done", step: "submitted", clipIds: [CLIP_A] }, TAB_ID, "https://suno.com/create");
  await flush();
  assert.equal(world.controller.snapshot().phase, "rendering", "id bài mới vẫn được nhận sau khi bấm dừng");
});

test("Xoá nhật ký đi qua controller; lệnh lạ được trả lời lỗi thay vì im lặng", async () => {
  const world = fakeWorld();
  await connected(world);
  await flush();
  assert.ok(world.local.jrActivity.length > 0);
  assert.deepEqual(fromPanel(world, "clear_log"), [{ cleared: true }]);
  await flush();
  await flush();
  assert.deepEqual(world.local.jrActivity, []);
  assert.deepEqual(fromPanel(world, "khong-co"), [{ error: "unknown_action" }]);
});

test("mất cầu nối giữa việc → thẻ 'việc đang chạy' được xoá khỏi side panel", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await runToDownloading(world, ws);
  assert.equal(world.session.jrCurrentJob.phase, "downloading");
  ws.close();
  await flush();
  assert.equal(world.session.jrCurrentJob, null);
});

test("cầu nối báo đường dẫn trong welcome → extension ghi nhớ để khung Copy cấu hình MCP tự điền", async () => {
  const world = fakeWorld();
  const stored = {};
  world.chrome.storage.local.set = async (value) => Object.assign(stored, value);
  await world.controller.start();
  const ws = world.sockets.at(-1);
  ws.open();
  const hello = ws.sent[0];
  await ws.receive({ type: "challenge", nonce: SERVER_NONCE, proof: await hmacHex("paired", bridgeProofInput(hello.nonce, SERVER_NONCE)) });
  await ws.receive({ type: "welcome", bridgePath: "D:/repo/scripts/suno_agent_bridge.py" });
  await flush();
  assert.equal(stored.bridgePath, "D:/repo/scripts/suno_agent_bridge.py");
});

const QUEUE_PICTURE = {
  type: "queue",
  paused: false,
  episodes: [{ episode: JOB.episode, jobs: [
    { id: JOB.id, kind: "export_download", slot: 1, status: "queued", step: null, reason: null, title: JOB.expectedTitle, at: "2026-09-28T00:00:00Z" }
  ] }]
};

test("ảnh hàng chờ từ cầu nối đã xác thực được lưu cho side panel", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive(QUEUE_PICTURE);
  await flush();
  assert.equal(world.session.jrQueue.episodes[0].jobs[0].id, JOB.id);
  assert.equal(typeof world.session.jrQueue.receivedAt, "number");
});

test("ảnh hàng chờ trước khi bắt tay xong bị bỏ qua", async () => {
  const world = fakeWorld();
  await world.controller.start();
  const ws = world.sockets.at(-1);
  ws.open();
  await ws.receive(QUEUE_PICTURE);
  await flush();
  assert.equal(world.session.jrQueue, undefined);
});

test("Chạy tiếp từ side panel: gửi control resume cho cầu nối đã xác thực", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  const replies = fromPanel(world, "resume");
  await flush();
  assert.deepEqual(replies, [{ sent: true }]);
  assert.deepEqual(ws.sent.at(-1), { type: "control", action: "resume" });
});

test("Chạy tiếp khi chưa nối cầu nối: báo không gửi được, không gửi gì", async () => {
  const world = fakeWorld();
  await world.controller.start();
  const replies = fromPanel(world, "resume");
  await flush();
  assert.deepEqual(replies, [{ sent: false }]);
});

test("tab Suno bị che giữa bước: đồng hồ bước treo, báo đang chờ; hiện lại thì chạy tiếp, cầu nối không bị dừng", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  const stepTimer = world.timers.filter((t) => !t.interval && t.ms === STEP_TIMEOUT_MS.opening_studio).at(-1);
  fromContent(world, { type: "hidden", hidden: true });
  await flush();
  assert.deepEqual(world.session.status, { kind: "human", detail: "tab_hidden_wait" });
  await stepTimer.fn(); // hẹn giờ cũ nổ trong lúc chờ: không được đánh hỏng job
  await flush();
  assert.equal(ws.sent.some((m) => m.type === "result" || m.type === "alert"), false, "không kết thúc job, không bảo cầu nối dừng hàng chờ");
  const timersBefore = world.timers.length;
  fromContent(world, { type: "hidden", hidden: false });
  await flush();
  assert.equal(world.session.status.kind, "run");
  assert.equal(world.timers.slice(timersBefore).some((t) => t.ms === STEP_TIMEOUT_MS.opening_studio), true, "đặt lại đồng hồ bước");
  fromContent(world, { type: "content_done", step: "studio_ready" });
  await flush();
  assert.equal(world.sentToTab.at(-1).command, "export_full_song");
});

test("báo che/hiện của lệnh cũ bị bỏ qua", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  fromContent(world, { type: "hidden", hidden: true, commandId: 9999 });
  await flush();
  assert.equal(world.session.status.kind, "run");
});

test("mở side panel khi chưa nối: nối lại ngay, không đợi báo thức", async () => {
  const world = fakeWorld();
  await world.controller.start();
  world.sockets.at(-1).close?.();
  const before = world.sockets.length;
  const replies = fromPanel(world, "connect");
  await flush();
  assert.deepEqual(replies, [{ connecting: true }]);
  assert.ok(world.sockets.length >= before, "có socket (mới hoặc đang mở)");
});

test("cửa sổ Suno đang thu nhỏ: bung ra (không đổi cỡ cửa sổ đang phóng to)", async () => {
  const world = fakeWorld();
  world.chrome.windows.state = "minimized";
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  assert.deepEqual(world.chrome.windows.focused.at(-1), { id: 7, focused: true, drawAttention: true, state: "normal" });
});

// ── thông báo Windows + đếm việc còn lại ──────────────────────────────────────────────────

const pictureOf = (statuses) => ({
  type: "queue",
  paused: false,
  episodes: [{ episode: JOB.episode, jobs: statuses.map((status, i) => ({
    id: `EP006.01.${String(i + 1).repeat(8)}-1111-4111-8111-111111111111`, kind: "export_download", slot: 1, status,
    step: null, reason: null, title: JOB.expectedTitle, at: "2026-09-28T00:00:00Z"
  })) }]
});

test("cần người: hiện thông báo Windows kèm việc cần làm", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await runToDownloading(world, ws);
  fromContent(world, { type: "human_needed", reason: "captcha" });
  await flush();
  await flush();
  const note = world.chrome.notifications.shown.at(-1);
  assert.match(note.title, /Cần bạn/);
  assert.match(note.message, /Chạy tiếp/);
});

test("cửa sổ Suno bị che: thông báo một lần", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  fromContent(world, { type: "hidden", hidden: true });
  fromContent(world, { type: "hidden", hidden: true });
  await flush();
  await flush();
  assert.equal(world.chrome.notifications.shown.filter((n) => /bị che/.test(n.title)).length, 1);
});

test("cả tập vừa chạy xong: thông báo 'Xong' một lần", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive(pictureOf(["done", "running"]));
  await ws.receive(pictureOf(["done", "done"]));
  await ws.receive(pictureOf(["done", "done"]));
  await flush();
  await flush();
  const done = world.chrome.notifications.shown.filter((n) => /Xong/.test(n.title));
  assert.equal(done.length, 1);
  assert.match(done[0].title, /EP006/);
  assert.match(done[0].message, /2\/2/);
});

test("tắt thông báo trong Cài đặt thì không hiện", async () => {
  const world = fakeWorld();
  world.local.jrNotify = false;
  const ws = await connected(world);
  await ws.receive(pictureOf(["running"]));
  await ws.receive(pictureOf(["done"]));
  await flush();
  await flush();
  assert.equal(world.chrome.notifications.shown.length, 0);
});

test("đang chạy: icon đếm số việc còn lại", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive(pictureOf(["done", "running", "queued", "queued"]));
  await ws.receive({ type: "job", job: JOB });
  await flush();
  await flush();
  assert.equal(world.chrome.action.badge.at(-1), "3");
});

test("ảnh gọn của trang từ content script được cắt ngắn trước khi gửi đi", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  const labels = [...Array(80).keys()].map((i) => `nút ${i} ${"x".repeat(100)}`);
  fromContent(world, { type: "content_error", step: "wait_studio_ready", reason: "boom", hint: { path: "/studio?x=" + "y".repeat(500), labels: [...labels, 42, null] } });
  await flush();
  const hint = ws.sent.find((m) => m.type === "result").domHint;
  assert.equal(hint.labels.length, 40);
  assert.ok(hint.labels.every((l) => typeof l === "string" && l.length <= 60));
  assert.ok(hint.path.length <= 80);
});

test("welcome: nhớ phiên bản cầu nối cho chân trang", async () => {
  const world = fakeWorld();
  await world.controller.start();
  const ws = world.sockets.at(-1);
  ws.open();
  const hello = ws.sent[0];
  await ws.receive({ type: "challenge", nonce: SERVER_NONCE, proof: await hmacHex("paired", bridgeProofInput(hello.nonce, SERVER_NONCE)) });
  await ws.receive({ type: "welcome", bridgeVersion: "0.3.2" });
  await flush();
  assert.equal(world.session.bridgeVersion, "0.3.2");
});

// ── kết nối: một socket duy nhất, socket thừa đóng không phá job đang chạy ─────────────────

test("gọi nối hai lần sát nhau khi chưa có socket (báo thức + mở side panel): chỉ mở MỘT socket", async () => {
  const world = fakeWorld();
  await world.controller.start();
  world.sockets.at(-1).close(); // cầu nối tắt: không còn socket nào
  const before = world.sockets.length;
  fromPanel(world, "connect");
  fromPanel(world, "connect");
  await flush();
  await flush();
  assert.equal(world.sockets.length, before + 1, "hai lần gọi cùng lúc chỉ được mở một socket");
});

test("socket thừa đóng muộn KHÔNG huỷ job của socket đang sống", async () => {
  const world = fakeWorld();
  await world.controller.start();
  const first = world.sockets.at(-1);
  first.readyState = 3; // socket cũ "đã chết" nhưng chưa kịp báo onclose
  fromPanel(world, "connect");
  await flush();
  const live = world.sockets.at(-1);
  assert.notEqual(live, first);
  live.open();
  const hello = live.sent[0];
  await live.receive({ type: "challenge", nonce: SERVER_NONCE, proof: await hmacHex("paired", bridgeProofInput(hello.nonce, SERVER_NONCE)) });
  await live.receive({ type: "welcome" });
  await live.receive({ type: "job", job: JOB });
  await flush();
  first.onclose?.(); // báo đóng của socket cũ tới muộn
  await flush();
  assert.equal(world.session.jrCurrentJob?.id, JOB.id, "job của socket đang sống vẫn chạy");
  assert.equal(world.session.status.kind, "run");
});

test("socket đang sống đóng: nối lại nhanh (≤ 1 s lần đầu)", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  const before = world.timers.length;
  ws.close();
  await flush();
  const retry = world.timers.slice(before).find((t) => !t.interval);
  assert.ok(retry && retry.ms <= 1000, `lần nối lại đầu sau ${retry?.ms} ms`);
});

// ── tự cập nhật trên máy dev: cầu nối mới hơn → extension tự nạp lại khi rảnh ──────────────

test("cầu nối bảo nạp lại khi đang rảnh: extension tự nạp lại (chép code mới từ ổ đĩa)", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "reload" });
  await flush();
  assert.equal(world.chrome.runtime.reloaded, 1);
  assert.equal(typeof world.local.jrLastSelfReload, "number");
});

test("đang chạy job thì KHÔNG nạp lại (để job xong trước)", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  await ws.receive({ type: "reload" });
  await flush();
  assert.equal(world.chrome.runtime.reloaded, 0);
});

test("bảo nạp lại lúc đang chạy job: nạp ngay khi job xong, không quên", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: JOB });
  await flush();
  await ws.receive({ type: "reload" });
  await flush();
  assert.equal(world.chrome.runtime.reloaded, 0);
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  fromContent(world, { type: "content_error", step: "wait_studio_ready", reason: "boom" });
  await flush();
  assert.equal(world.controller.snapshot().phase, "idle");
  assert.equal(world.chrome.runtime.reloaded, 1);
});

test("vừa tự nạp lại trong 10 phút: không nạp nữa (chống lặp vô hạn khi lệch bản)", async () => {
  const world = fakeWorld();
  world.local.jrLastSelfReload = Date.now() - 60_000;
  const ws = await connected(world);
  await ws.receive({ type: "reload" });
  await flush();
  assert.equal(world.chrome.runtime.reloaded, 0);
});

const STEMS_JOB = { id: "EP006.01.ST1", kind: "stems_split", episode: "EP006-deep-autumn-post-town-inn", slot: 1, take: 1,
  candidateId: CANDIDATE, expectedTitle: "雨夜の宿口", minSeconds: 320, dryRun: false };

test("tách stem: Open in Studio tải lại trang → lệnh chờ Studio chỉ gửi SAU khi trang mới nạp xong", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: STEMS_JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  assert.equal(world.sentToTab.at(-1).command, "open_stems_dialog");
  fromContent(world, { type: "content_done", step: "stems_dialog", hasStems: true, stems: ["Bass", "Strings"] }, TAB_ID, `https://suno.com/song/${CANDIDATE}`);
  await flush();
  assert.equal(world.sentToTab.at(-1).command, "open_stems_studio");
  assert.equal(world.sentToTab.some((m) => m.command === "wait_stems_studio"), false);
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  const waitStudio = world.sentToTab.at(-1);
  assert.equal(waitStudio.command, "wait_stems_studio");
  assert.equal(waitStudio.job.stemCount, 2);
});

test("DỪNG NGAY khi Suno đang tách stem: KHÔNG cắt job (credit đã trừ), chỉ tạm dừng hàng chờ", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: STEMS_JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  fromContent(world, { type: "content_done", step: "stems_dialog", stems: [] }, TAB_ID, `https://suno.com/song/${CANDIDATE}`);
  await flush();
  assert.equal(world.controller.snapshot().phase, "extracting");
  assert.deepEqual(fromPanel(world, "stop"), [{ stopped: false, finishing: true }]);
  await flush();
  assert.equal(world.controller.snapshot().phase, "extracting");
  assert.equal(ws.sent.some((m) => m.type === "result"), false);
});

test("tách stem: mất cầu nối đúng lúc sắp bấm Extract → KHÔNG ra lệnh bấm (cầu nối phải biết trước khi tiêu credit)", async () => {
  const world = fakeWorld();
  const ws = await connected(world);
  await ws.receive({ type: "job", job: STEMS_JOB });
  await flush();
  world.chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" });
  await flush();
  ws.readyState = 3; // socket vừa đứt, onclose chưa kịp chạy
  fromContent(world, { type: "content_done", step: "stems_dialog", hasStems: false, stems: [] }, TAB_ID, `https://suno.com/song/${CANDIDATE}`);
  await flush();
  assert.equal(world.sentToTab.some((m) => m.command === "extract_stems"), false);
  assert.equal(world.controller.snapshot().phase, "idle");
});
