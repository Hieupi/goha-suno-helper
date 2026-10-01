// Đóng vai extension THẬT (lib/controller.js + WebSocket thật của Node) nói chuyện với cầu nối Python
// THẬT qua 127.0.0.1 — chỉ trang Suno (content script) và chrome.* là đồ giả tự trả lời.
// Do tests/test_suno_wire_e2e.py khởi chạy; không tự chạy trong `node --test` (không phải *.test.mjs).
//
// Biến môi trường: JR_PORT, JR_TOKEN, JR_EXPORT (uuid bản export giả), JR_TITLE (tiêu đề Suno của bài
// tải, vd "EP900.01. Slot 1"), JR_CLIP (uuid bài giả sau Create).
import { readFileSync } from "node:fs";
import { createController } from "../lib/controller.js";

const { JR_PORT, JR_TOKEN, JR_EXPORT, JR_TITLE, JR_CLIP } = process.env;
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const TAB_ID = 1;
// Cùng phiên bản với manifest thật: cầu nối bảo extension CŨ HƠN nạp lại thay vì giao việc.
const MANIFEST = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

function listener() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...args) => fns.map((fn) => fn(...args)), fns };
}

const local = { pairingToken: JR_TOKEN, bridgeUrl: `ws://127.0.0.1:${JR_PORT}` };
const session = {};
const downloads = new Map();
const later = (fn, ms = 20) => setTimeout(fn, ms);

const chrome = {
  runtime: { id: EXTENSION_ID, getManifest: () => MANIFEST, onMessage: listener(), onStartup: listener(), onInstalled: listener() },
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
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: {
    create: async () => {
      later(() => chrome.tabs.onUpdated.fire(TAB_ID, { status: "complete" }));
      return { id: TAB_ID, windowId: 1 };
    },
    update: async (id) => {
      later(() => chrome.tabs.onUpdated.fire(id, { status: "complete" }));
      return { id, windowId: 1 };
    },
    get: async (id) => ({ id }),
    sendMessage: async (_id, message) => later(() => fakeContent(message)),
    onUpdated: listener(),
    onRemoved: listener()
  },
  windows: { update: async () => {} },
  downloads: { onDeterminingFilename: listener(), onChanged: listener(), search: async ({ id }) => [downloads.get(id)].filter(Boolean) },
  alarms: { create: () => {}, onAlarm: listener() }
};

/** Trang Suno giả: trả lời đúng hình dạng content.js thật gửi, mang commandId của lệnh. */
function fakeContent(message) {
  const reply = (event) =>
    chrome.runtime.onMessage.fire({ type: "jr.content", event: { ...event, commandId: message.commandId } }, { id: EXTENSION_ID, tab: { id: TAB_ID }, url: "https://suno.com/x" });
  switch (message.command) {
    case "wait_studio_ready":
      return reply({ type: "content_done", step: "studio_ready" });
    case "export_full_song":
      return reply({ type: "content_done", step: "exported", exportId: JR_EXPORT });
    case "wait_song_ready":
      return reply({ type: "content_done", step: "song_ready" });
    case "download_wav": {
      reply({ type: "content_done", step: "download_started" });
      // Lượt tải đúng hình dạng đo 27/09: blob ngẫu nhiên, referrer rỗng, tên = tiêu đề.
      const item = { id: 9, url: "blob:https://suno.com/ff91b3ce-0bec-496c-bf4c-296962ac83f2", referrer: "", filename: `${JR_TITLE}.wav` };
      chrome.downloads.onDeterminingFilename.fire(item, (suggestion) => {
        downloads.set(9, { id: 9, filename: `C:\\fake\\${suggestion.filename.replaceAll("/", "\\")}`, mime: "audio/wav" });
        later(() => chrome.downloads.onChanged.fns.forEach((fn) => fn({ id: 9, state: { current: "complete" } })));
      });
      return undefined;
    }
    case "fill_create_form":
      return reply({ type: "content_done", step: "form_ready", observed: { model: "v6", max_mode: true, styles_char_count: 700 }, mismatches: [] });
    case "submit_create":
      return reply({ type: "content_done", step: "submitted", clipIds: [JR_CLIP] });
    default:
      return undefined;
  }
}

/** Cầu nối chỉ nhận Origin chrome-extension:// — WebSocket của Node cho đặt header này. */
class ExtensionSocket extends globalThis.WebSocket {
  constructor(url) {
    super(url, { headers: { Origin: `chrome-extension://${EXTENSION_ID}` } });
  }
}

const fetchFn = async (url) => {
  const id = url.split("/").at(-1);
  const title = id === JR_EXPORT ? JR_TITLE : "gen";
  return { ok: true, json: async () => ({ id, status: "complete", title, metadata: { duration: 330 } }) };
};

await createController({
  chrome,
  WebSocketImpl: ExtensionSocket,
  setTimeoutFn: setTimeout,
  clearTimeoutFn: clearTimeout,
  setIntervalFn: setInterval,
  clearIntervalFn: clearInterval,
  fetchFn
}).start();
setTimeout(() => process.exit(0), Number(process.env.JR_LIFETIME_MS ?? 20_000));
