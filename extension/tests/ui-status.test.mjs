import test from "node:test";
import assert from "node:assert/strict";
import { agoText, badgeFor, durationText, episodeShort, heroFor, pillFor, timelineFor } from "../lib/ui-status.js";

// Chữ và trạng thái hiển thị: đúng tiếng Việt dễ hiểu, badge không chữ tiếng Anh, không trạng thái nào rơi vào khoảng trống.

test("badge không dùng chữ tiếng Anh và luôn có tooltip câu đầy đủ", () => {
  for (const kind of ["off", "key", "on", "run", "human"]) {
    const badge = badgeFor(kind, kind === "run" ? "downloading" : "captcha");
    assert.ok(!/[A-Za-z]/.test(badge.text), `${kind}: "${badge.text}"`);
    assert.match(badge.title, /^GOHA Suno Helper — /);
  }
  assert.equal(badgeFor("on").text, "");
  assert.equal(badgeFor("human", "captcha").text, "!");
  assert.match(badgeFor("human", "captcha").title, /có phải người/);
  assert.match(badgeFor("run", "downloading").title, /Đang tải WAV/);
  assert.equal(badgeFor("khong-co").text, "…");
});

test("thẻ chính: chưa có mã → dẫn tới Cài đặt, cần người → mở Suno, lỗi cầu nối hiện lý do", () => {
  assert.equal(heroFor({ status: null, hasToken: false }).action, "settings");
  const human = heroFor({ status: { kind: "human", detail: "user_stop" }, hasToken: true });
  assert.equal(human.tone, "shu");
  assert.match(human.body, /“Chạy tiếp”/, "chỉ đúng nút cần bấm");
  assert.equal(heroFor({ status: { kind: "on" }, hasToken: true }).tone, "matsu");
  assert.match(heroFor({ status: { kind: "off" }, hasToken: true, lastBridgeError: "sai bằng chứng" }).body, /sai bằng chứng/);
  assert.equal(heroFor({ status: { kind: "run", detail: "rendering" }, hasToken: true }).body, "Suno đang tạo nhạc");
});

test("viên trạng thái: chưa có mã luôn là Chưa thiết lập", () => {
  assert.equal(pillFor("on", false).text, "Chưa thiết lập");
  assert.equal(pillFor("run").tone, "ai");
  assert.equal(pillFor(undefined).text, "Chưa nối");
});

test("dòng thời gian: bước trước xong, bước hiện tại, bước sau chờ", () => {
  const steps = timelineFor({ kind: "export_download", phase: "checking_export" });
  assert.deepEqual(steps.map((s) => s.state), ["done", "done", "now", "todo", "todo"]);
  assert.equal(steps[2].label, "Chờ Suno chuẩn bị file");
  assert.deepEqual(timelineFor({ kind: "generate", phase: "rendering" }).map((s) => s.state), ["done", "done", "now"]);
  assert.deepEqual(timelineFor(null), []);
});

test("thời gian đọc được", () => {
  assert.equal(durationText(4000), "4 giây");
  assert.equal(durationText(245_000), "4 phút 05 giây");
  assert.equal(agoText(0, 30_000), "30 giây trước");
  assert.equal(agoText(0, 180_000), "3 phút trước");
  assert.equal(episodeShort("EP008-winter-edo-reading-room"), "EP008");
});

test("chân trang: bản dev = PREMIUM vĩnh viễn; lệch phiên bản ext/cầu nối thì cảnh báo", async () => {
  const { licenseFor, versionLine } = await import("../lib/ui-status.js");
  assert.deepEqual(licenseFor({ update_url: undefined }), { premium: true, label: "PREMIUM", title: "Bản tặng cộng đồng — mọi tính năng đã mở, miễn phí vĩnh viễn" });
  assert.equal(licenseFor({ update_url: "https://x/updates.xml" }).premium, false);
  assert.deepEqual(versionLine("0.3.2", "0.3.2"), { text: "Ext v0.3.2 · App v0.3.2", warn: false });
  assert.deepEqual(versionLine("0.3.2", "0.3.1"), { text: "Ext v0.3.2 · App v0.3.1 — lệch bản, mở lại trợ lý AI", warn: true });
  assert.deepEqual(versionLine("0.3.2", null), { text: "Ext v0.3.2 · App chưa nối", warn: false });
});
