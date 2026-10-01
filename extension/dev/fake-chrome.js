// Dev-only: bản giả chrome.* để xem side panel ngoài extension (dev/panel-preview.html).
// ?state=run|wait|human|key|on|off chọn kịch bản (wait = cửa sổ Suno bị che, bộ lái đứng chờ); ?skin=neon|classic&theme=light|dark chọn da.
(() => {
  const params = new URLSearchParams(location.search);
  const state = params.get("state") ?? "run";
  if (params.get("skin")) localStorage.setItem("jrSkin", params.get("skin"));
  if (params.get("theme")) localStorage.setItem("jrTheme", params.get("theme"));
  const now = Date.now();
  const statuses = {
    run: { kind: "run", detail: "checking_export" },
    human: { kind: "human", detail: "captcha" },
    wait: { kind: "human", detail: "tab_hidden_wait" },
    key: { kind: "key", detail: "" },
    on: { kind: "on", detail: "" },
    off: { kind: "off", detail: "" }
  };
  const session = {
    bridgeVersion: params.get("bridge") ?? "1.0.1",
    status: statuses[state] ?? statuses.run,
    lastBridgeError: state === "off" ? "Cổng 47831 không phải cầu nối đã ghép cặp (sai bằng chứng)." : null,
    jrCurrentJob: state === "run"
      ? { id: "EP008.05.x", kind: "export_download", title: "EP008.05. 雪見障子の午後", episode: "EP008-winter-edo-reading-room", slot: 5, phase: "checking_export", startedAt: now - 95_000, phaseAt: now - 21_000 }
      : null,
    _activity: [
      { at: now - 600_000, level: "ok", text: "Đã kết nối cầu nối" },
      { at: now - 420_000, level: "info", text: "Nhận việc: EP008.04. 頁をめくる" },
      { at: now - 200_000, level: "ok", text: "Xong: EP008.04. 頁をめくる" },
      { at: now - 95_000, level: "info", text: "Nhận việc: EP008.05. 雪見障子の午後" },
      ...(state === "human" ? [{ at: now - 30_000, level: "warn", text: "Cần bạn xử lý: Suno hỏi bạn có phải người không" }] : [])
    ]
  };
  // Ảnh hàng chờ kiểu cầu nối gửi (tin `queue`): EP008 slot 5–18, mỗi slot 2 take, nhịp ~1:45/việc.
  const titles = ["墨と炭の香", "障子の白い静寂", "手のひらのぬくもり", "冬の午後の読書", "静かな集中の時", "音もなく降る雪", "灯りのそばで",
    "ゆるやかな安らぎ", "部屋の深い静寂", "暮れてのちの雪", "息をひそめて", "夜の書架", "名残の温もり", "書を閉じて、静かに"];
  const PACE = 105_000;
  const doneCount = 13;
  const jobs = titles.flatMap((title, i) => [1, 2].map((take) => ({ slot: i + 5, take, title })))
    .map((job, index) => {
      let status = index < doneCount ? "done" : index === doneCount ? "running" : "queued";
      let step = status === "running" ? "checking_export" : status === "done" ? "downloading" : null;
      let reason = null;
      if (state === "human" && index === doneCount) { status = "needs_human"; step = "opening_studio"; reason = "captcha"; }
      const at = new Date(status === "done" ? now - (doneCount - index) * PACE + 30_000 : now - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
      const id = `EP008.${String(job.slot).padStart(2, "0")}.${String(job.take).repeat(8)}-${String(index).padStart(4, "0")}-4111-8111-111111111111`;
      return { id, kind: "export_download", slot: job.slot, status, step, reason, title: job.title, at };
    });
  if (state === "run" || state === "human" || state === "wait") {
    session.jrQueue = { type: "queue", paused: state === "human", episodes: [{ episode: "EP008-winter-edo-reading-room", jobs }], receivedAt: now - 5_000 };
  }
  const local = state === "key" ? { pairingToken: "devPreviewOnly_notARealCode_0123456789abcdef" } : { pairingToken: "devPreviewOnly_notARealCode_0123456789abcdef", bridgePath: String.raw`D:\GOHA-Suno-Helper\bridge\goha_suno\suno_agent_bridge.py` };
  const pick = (store, keys) => Object.fromEntries([keys].flat().filter((k) => k in store).map((k) => [k, store[k]]));
  local.jrActivity = session._activity; // nhật ký nằm ở storage.local (còn sau khi tắt Chrome)
  const listener = () => ({ addListener() {} });
  window.chrome = {
    runtime: { getManifest: () => ({ version: "1.0.1", version_name: "1.0.1 · ProMax" }), sendMessage: async () => ({ stopped: true }) },
    storage: {
      session: { get: async (keys) => pick(session, keys), set: async (value) => Object.assign(session, value) },
      local: { get: async (keys) => pick(local, keys), set: async (value) => Object.assign(local, value) },
      onChanged: listener()
    },
    tabs: { query: async () => (state === "on" ? [{ id: 1, windowId: 1 }] : []), update: async () => {}, create: async () => {}, onUpdated: listener(), onRemoved: listener() },
    windows: { update: async () => {} }
  };
})();
