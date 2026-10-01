import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Canh bề mặt quyền: mọi quyền thêm vào phải là quyết định có chủ đích, không lặng lẽ nở ra.
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const UI_SCRIPTS = ["sidepanel.js", "ui/dom.js", "ui/skin.js", "lib/ui-status.js"];

test("quyền tối thiểu: storage, downloads, alarms, sidePanel — không webRequest/debugger/cookies/tabs/scripting", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "downloads", "notifications", "sidePanel", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://suno.com/*", "https://studio-api.prod.suno.com/*"]);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});

test("content script chỉ trên suno.com, isolated world, không all_frames", () => {
  assert.equal(manifest.content_scripts.length, 1);
  const [script] = manifest.content_scripts;
  assert.deepEqual(script.matches, ["https://suno.com/*"]);
  assert.equal(script.world, undefined);
  assert.equal(script.all_frames, undefined);
});

test("mọi file manifest trỏ tới đều tồn tại và đúng cú pháp", () => {
  const files = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((s) => s.js),
    manifest.options_page,
    "options.js",
    manifest.side_panel.default_path,
    ...UI_SCRIPTS,
    "ui/tokens.css",
    "ui/sidepanel.css"
  ];
  for (const rel of files) {
    const path = fileURLToPath(new URL(rel, root));
    assert.ok(existsSync(path), rel);
    if (rel.endsWith(".js")) {
      const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
      assert.equal(result.status, 0, `${rel}: ${result.stderr}`);
    }
  }
});

test("không innerHTML / eval / new Function trong mã extension", () => {
  for (const rel of ["background.js", "content.js", "options.js", "lib/controller.js", "lib/protocol.js", "lib/runner.js", "lib/naming.js", "lib/downloads.js", "lib/suno-logic.js", "lib/suno-dom.js", ...UI_SCRIPTS]) {
    const source = readFileSync(new URL(rel, root), "utf8");
    assert.ok(!/innerHTML|\beval\(|new Function/.test(source), rel);
  }
});

test("icon đủ 16/32/48/128, đúng kích thước PNG khai báo", () => {
  for (const [size, rel] of Object.entries(manifest.icons)) {
    const png = readFileSync(new URL(rel, root));
    assert.equal(png.toString("latin1", 1, 4), "PNG", rel);
    assert.equal(png.readUInt32BE(16), Number(size), `${rel} rộng`);
    assert.equal(png.readUInt32BE(20), Number(size), `${rel} cao`);
  }
  assert.deepEqual(Object.keys(manifest.icons).sort((a, b) => a - b), ["16", "32", "48", "128"]);
  assert.deepEqual(manifest.action.default_icon, { 16: manifest.icons["16"], 32: manifest.icons["32"] });
});

test("side panel là giao diện chính: khai báo side_panel, sidepanel.html nạp skin.js trong <head> trước CSS", () => {
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  const html = readFileSync(new URL("sidepanel.html", root), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(head.indexOf("ui/skin.js") > -1 && head.indexOf("ui/skin.js") < head.indexOf("ui/tokens.css"), "skin.js phải chạy trước khi nạp CSS");
  assert.ok(/<script src="sidepanel.js" type="module">/.test(html));
  assert.ok(!/<script>[^<]/.test(html), "không script nội tuyến (CSP)");
  const background = readFileSync(new URL("background.js", root), "utf8");
  assert.ok(/setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/.test(background), "bấm icon phải mở side panel");
});

test("trang xem trước dev luôn dựng từ sidepanel.html (không lệch giao diện)", async () => {
  const { readFileSync } = await import("node:fs");
  const { previewHtml } = await import("../tools/make-panel-preview.mjs");
  const real = readFileSync(new URL("../sidepanel.html", import.meta.url), "utf8");
  const preview = readFileSync(new URL("../dev/panel-preview.html", import.meta.url), "utf8");
  assert.equal(preview, previewHtml(real), "chạy: node tools/make-panel-preview.mjs");
});
