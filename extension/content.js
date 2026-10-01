// JR Suno Helper — content script trên suno.com (isolated world, KHÔNG tiêm MAIN world).
// Nhận lệnh từ background, gọi bộ lái trong lib/suno-dom.js (nạp trước trong manifest cùng
// lib/suno-logic.js), báo kết quả. CAPTCHA/đăng xuất → dừng và gọi chủ kênh, không bao giờ tương tác
// với widget. Tab bị che → đứng chờ tại chỗ (không làm gì trên trang) tới khi cửa sổ hiện lại.
(() => {
  const drivers = globalThis.JrSunoDrivers;
  let aborted = false;

  // Id của lệnh đang chạy — gắn vào mọi báo cáo để background bỏ qua báo cáo trễ của lệnh cũ.
  let currentId = null;

  function report(event, commandId = currentId) {
    void chrome.runtime.sendMessage({ type: "jr.content", event: { ...event, commandId } }).catch(() => {});
  }

  drivers.setHiddenListener((hidden) => report({ type: "hidden", hidden }));

  async function run(command, job, commandId) {
    if (command === "stop") {
      aborted = true;
      return;
    }
    aborted = false;
    currentId = commandId;
    const reason = drivers.humanNeeded();
    if (reason) {
      report({ type: "human_needed", reason });
      return;
    }
    const driver = drivers.commands[command];
    if (!driver) {
      report({ type: "content_error", step: command, reason: "unknown_command" });
      return;
    }
    const stopped = () => aborted || currentId !== commandId;
    try {
      await drivers.waitWhileHidden(stopped); // không bắt đầu thao tác nào khi tab đang bị che
      if (stopped()) return;
      const outcome = await driver(job ?? {}, stopped);
      if (!aborted) report({ type: "content_done", ...outcome }, commandId);
    } catch (error) {
      if (aborted) return;
      if (error instanceof drivers.HumanNeeded) {
        report({ type: "human_needed", reason: error.reason }, commandId);
        return;
      }
      const human = drivers.humanNeeded();
      report(
        human
          ? { type: "human_needed", reason: human }
          : { type: "content_error", step: command, reason: String(error?.message ?? error).slice(0, 120), hint: drivers.pageHint() },
        commandId
      );
    }
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "jr.command") return;
    void run(String(message.command), message.job ?? null, Number.isInteger(message.commandId) ? message.commandId : null);
  });
})();
