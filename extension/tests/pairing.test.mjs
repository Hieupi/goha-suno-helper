import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DEFAULT_BRIDGE_PATH, cleanBridgePath, installInfo, maskCode, mcpConfig, newPairingCode, validPairingCode } from "../lib/pairing.js";
import { parseIncoming } from "../lib/protocol.js";

// Kết nối kiểu Goha: một khối cấu hình MCP có sẵn mã, một nút Copy. Mã sinh ở extension phải qua được
// bộ kiểm của cầu nối Python (^[A-Za-z0-9_-]{32,128}$).

const PATH = "D:\\Other Folder\\repo\\bridge\\goha_suno\\suno_agent_bridge.py";

test("mã mới: 43 ký tự base64url, đủ điều kiện cầu nối, mỗi lần một khác", () => {
  const a = newPairingCode((n) => randomBytes(n));
  const b = newPairingCode((n) => randomBytes(n));
  assert.equal(a.length, 43);
  assert.ok(validPairingCode(a) && validPairingCode(b));
  assert.notEqual(a, b);
  assert.equal(validPairingCode("ngắn"), false);
  assert.equal(validPairingCode(undefined), false);
});

test("một khối mcpServers dùng chung: đúng lệnh, đường dẫn Windows thoát đúng, mã + UTF-8 trong env", () => {
  const parsed = JSON.parse(mcpConfig({ code: "C0DE", bridgePath: PATH }));
  assert.deepEqual(parsed, {
    mcpServers: { "jr-suno": { command: "python", args: [PATH], env: { JR_SUNO_PAIRING_CODE: "C0DE", PYTHONUTF8: "1" } } }
  });
});

test("chưa biết đường dẫn → tự điền mặc định, người dùng không phải nhập gì", () => {
  assert.equal(JSON.parse(mcpConfig({ code: "C0DE", bridgePath: "" })).mcpServers["jr-suno"].args[0], DEFAULT_BRIDGE_PATH);
  assert.equal(cleanBridgePath(`  "${PATH}"  `), PATH);
});

test("mã hiển thị luôn che, không lộ phần đuôi", () => {
  const code = "abcdEFGHijklMNOPqrstUVWXyz0123456789_-abcde";
  assert.equal(maskCode(code), "abcd…••••••••");
  assert.equal(maskCode(code).includes(code.slice(4)), false);
});

test("welcome của cầu nối mang đường dẫn .py hợp lệ thì extension nhận, lạ thì bỏ", () => {
  assert.deepEqual(parseIncoming(JSON.stringify({ type: "welcome", protocol: 2, bridgePath: PATH })).message, { type: "welcome", bridgePath: PATH });
  assert.deepEqual(parseIncoming(JSON.stringify({ type: "welcome", bridgePath: "C:\\evil.exe" })).message, { type: "welcome" });
  assert.deepEqual(parseIncoming(JSON.stringify({ type: "welcome", bridgePath: "x".repeat(500) + ".py" })).message, { type: "welcome" });
});

test("install.json của trình cài: chỉ nhận đường dẫn .py / .exe, đưa python của máy vào cấu hình MCP", () => {
  const info = installInfo({ bridgePath: "C:/GOHA/bridge/goha_suno/suno_agent_bridge.py", python: "C:/Python312/python.exe", extra: "x" });
  assert.deepEqual(info, { bridgePath: "C:/GOHA/bridge/goha_suno/suno_agent_bridge.py", python: "C:/Python312/python.exe" });
  const server = JSON.parse(mcpConfig({ code: "C0DE", ...info })).mcpServers["jr-suno"];
  assert.deepEqual([server.command, server.args[0]], ["C:/Python312/python.exe", info.bridgePath]);
  assert.deepEqual(installInfo({ bridgePath: "rm -rf /", python: "calc.bat" }), { bridgePath: "", python: "" });
  assert.deepEqual(installInfo(null), { bridgePath: "", python: "" });
  assert.equal(JSON.parse(mcpConfig({ code: "C0DE" })).mcpServers["jr-suno"].command, "python");
  assert.equal(DEFAULT_BRIDGE_PATH.includes("AI PROJECTS"), false, "không lộ đường dẫn máy chủ kênh");
});

test("install.json: đường dẫn mạng (UNC), URL, đường dẫn tương đối hay có dấu nháy đều bị bỏ", () => {
  const unc = String.raw`\\evil\share\x.py`;
  for (const bad of [unc, "https://x.y/a.py", "bridge/x.py", 'C:/a".py', "C:/a\n.py"]) {
    assert.equal(installInfo({ bridgePath: bad }).bridgePath, "", JSON.stringify(bad));
  }
  const local = String.raw`D:\GOHA Suno\bridge\goha_suno\suno_agent_bridge.py`;
  assert.equal(installInfo({ bridgePath: local }).bridgePath, local);
});
