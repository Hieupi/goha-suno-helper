// Kết nối trợ lý AI kiểu Goha Flow: extension tự sinh mã, hiện MỘT khối cấu hình MCP (đã chứa mã) và
// MỘT nút Copy. Chủ kênh dán vào trợ lý AI (Claude Code / Codex / Antigravity) — trợ lý tự cài.
// Cầu nối đọc mã từ biến môi trường JR_SUNO_PAIRING_CODE. Logic thuần, test ở tests/pairing.test.mjs.

export const PAIRING_ENV = "JR_SUNO_PAIRING_CODE";
export const SERVER_NAME = "jr-suno";
export const BRIDGE_ADDRESS = "ws://127.0.0.1:47831";
// Đường dẫn cầu nối: CAI-DAT.bat của gói ghi vào install.json trong thư mục extension (installInfo); cầu nối cũng tự
// báo đường dẫn thật trong tin welcome. Chưa có cả hai thì hiện chỗ trống có hướng dẫn, không đoán đường dẫn máy ai.
export const DEFAULT_BRIDGE_PATH = "<thư mục GOHA-Suno-Helper>\\bridge\\scripts\\suno_agent_bridge.py";
export const DEFAULT_PYTHON = "python";
const CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** 32 byte ngẫu nhiên → base64url 43 ký tự (cùng độ mạnh secrets.token_urlsafe(32) phía Python). */
export function newPairingCode(randomBytes) {
  const bytes = randomBytes(32);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function validPairingCode(code) {
  return CODE_PATTERN.test(String(code ?? ""));
}

/** Đường dẫn tới cầu nối: bỏ nháy thừa khi dán từ Explorer ("Copy as path"); trống → mặc định. */
export function cleanBridgePath(path) {
  return String(path ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
}

/** Đường dẫn bắt đầu bằng ký tự ổ đĩa của máy này; không đường dẫn mạng (UNC), không URL, không xuống dòng hay dấu nháy. */
export const LOCAL_WINDOWS_PATH = /^[A-Za-z]:[\\/][^"\r\n<>|?*]*$/;

/** install.json do CAI-DAT.bat ghi: chỉ nhận đường dẫn .py / .exe trên ổ đĩa của máy này, không gì khác. */
export function installInfo(raw) {
  const pick = (value, ext) =>
    typeof value === "string" && value.length <= 400 && LOCAL_WINDOWS_PATH.test(value) && ext.test(value) ? cleanBridgePath(value) : "";
  return { bridgePath: pick(raw?.bridgePath, /\.py$/i), python: pick(raw?.python, /\.exe$/i) };
}

/** Khối cấu hình MCP dạng `mcpServers` — một khối dùng chung cho mọi trợ lý. */
export function mcpConfig({ code, bridgePath, python }) {
  const path = cleanBridgePath(bridgePath) || DEFAULT_BRIDGE_PATH;
  const command = cleanBridgePath(python) || DEFAULT_PYTHON;
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: { command, args: [path], env: { [PAIRING_ENV]: code, PYTHONUTF8: "1" } } } },
    null,
    2
  );
}

/** Che mã trong chuỗi hiển thị; chuỗi sao chép luôn dùng mã thật. */
export function maskCode(code) {
  return code ? `${code.slice(0, 4)}…${"•".repeat(8)}` : "";
}
