// JR Suno Helper — service worker. Toàn bộ logic nằm ở lib/controller.js (test được với đồ giả);
// ở đây chỉ nối với chrome.* và WebSocket thật.
import { createController } from "./lib/controller.js";

// Bấm icon trên thanh công cụ → mở side panel (giao diện chính).
void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

void createController({
  chrome,
  WebSocketImpl: WebSocket,
  setTimeoutFn: setTimeout,
  clearTimeoutFn: clearTimeout,
  setIntervalFn: setInterval,
  clearIntervalFn: clearInterval,
  fetchFn: (...args) => fetch(...args)
}).start();
