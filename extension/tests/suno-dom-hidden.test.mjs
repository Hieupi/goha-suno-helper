// Bộ lái khi tab Suno bị che: đứng chờ tại chỗ, báo che/hiện, chạy tiếp khi cửa sổ hiện lại.
// lib/suno-dom.js là script thường cho content script → nạp qua node:vm với document giả.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadDrivers() {
  const listeners = new Set();
  const document = {
    hidden: false,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => type === "visibilitychange" && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn)
  };
  const sandbox = {
    document, setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, performance,
    location: { pathname: "/studio" },
    getComputedStyle: () => ({ visibility: "visible" })
  };
  vm.createContext(sandbox);
  sandbox.globalThis = sandbox;
  vm.runInContext(readFileSync(new URL("../lib/suno-logic.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(readFileSync(new URL("../lib/suno-dom.js", import.meta.url), "utf8"), sandbox);
  const show = () => {
    document.hidden = false;
    for (const fn of [...listeners]) fn();
  };
  return { drivers: sandbox.JrSunoDrivers, document, show, listeners };
}

test("tab đang hiện: không chờ, không báo gì", async () => {
  const { drivers } = loadDrivers();
  const seen = [];
  drivers.setHiddenListener((hidden) => seen.push(hidden));
  assert.equal(await drivers.waitWhileHidden(() => false), 0);
  assert.deepEqual(seen, []);
});

test("tab bị che: báo che, chờ tới khi hiện lại, báo hiện, trả thời gian đã chờ", async () => {
  const { drivers, document, show, listeners } = loadDrivers();
  const seen = [];
  drivers.setHiddenListener((hidden) => seen.push(hidden));
  document.hidden = true;
  const waiting = drivers.waitWhileHidden(() => false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seen, [true], "đang chờ, chưa đi tiếp");
  show();
  const waited = await waiting;
  assert.deepEqual(seen, [true, false]);
  assert.ok(waited >= 20);
  assert.equal(listeners.size, 0, "gỡ bộ nghe sự kiện sau khi xong");
});

test("tab bị che: CAPTCHA / đăng xuất không còn, tab ẩn không phải lý do dừng job", () => {
  const { drivers, document } = loadDrivers();
  document.hidden = true;
  assert.equal(drivers.humanNeeded(), null);
});

test("đang chờ mà có lệnh dừng: thôi chờ", async () => {
  const { drivers, document } = loadDrivers();
  document.hidden = true;
  let stop = false;
  const waiting = drivers.waitWhileHidden(() => stop);
  stop = true;
  const waited = await waiting; // bộ đếm 1 s kiểm lệnh dừng
  assert.ok(waited >= 0);
});

test("ảnh gọn của trang: nhãn nút đang hiện, bỏ trùng, không lấy nút ẩn", () => {
  const { drivers, document } = loadDrivers();
  const el = (label, shown = true) => ({
    getAttribute: (name) => (name === "aria-label" ? label : null),
    textContent: "",
    getBoundingClientRect: () => ({ width: shown ? 10 : 0, height: shown ? 10 : 0 })
  });
  document.querySelectorAll = () => [el("Export menu"), el("Export menu"), el("Hidden", false), el("Full Song")];
  const hint = drivers.pageHint();
  assert.deepEqual([...hint.labels], ["Export menu", "Full Song"]); // mảng tạo trong vm: chép ra realm của test
});

test("mục menu: Suno đổi Download từ <button> sang <div role=menuitem> (29/09) — nhận cả hai", () => {
  const { drivers, document } = loadDrivers();
  const el = (tag, label, text = label, shown = true) => ({
    tagName: tag,
    getAttribute: (name) => (name === "aria-label" ? label : null),
    textContent: text,
    getBoundingClientRect: () => ({ width: shown ? 10 : 0, height: shown ? 10 : 0 })
  });
  const div = el("DIV", "Download");
  let asked = "";
  document.querySelectorAll = (selector) => {
    asked = selector;
    return selector.includes('[role="menuitem"]') ? [el("BUTTON", "Download", "Download", false), div] : [];
  };
  assert.equal(drivers.menuItem("Download"), div);
  assert.match(asked, /button/, "nút kiểu cũ vẫn nhận");
  assert.equal(drivers.menuItem("Full Song"), undefined);
});

test("mục menu: nhận theo chữ khi không có aria-label (Full Song, Multitrack trong Studio)", () => {
  const { drivers, document } = loadDrivers();
  const item = { getAttribute: () => null, textContent: " Full Song ", getBoundingClientRect: () => ({ width: 5, height: 5 }) };
  document.querySelectorAll = () => [item];
  assert.equal(drivers.menuItem("Full Song"), item);
});
