// Giãn cách nối lại cầu nối. 10 phút đầu thử lại ≤ 5 s: mỗi lần thử gọi API extension nên service worker
// không ngủ → trợ lý AI mở cầu nối lên là nối trong vài giây. Lâu hơn (không ai mở trợ lý) thì 30 s cho nhẹ máy;
// báo thức 30 s (controller) đánh thức service worker nếu nó đã ngủ.
const STEPS_MS = [500, 1000, 2000, 3000, 5000];
const FAST_ATTEMPTS = 120; // ~10 phút ở nhịp 5 s
const SLOW_MS = 30_000;

export function reconnectDelayMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  if (n >= FAST_ATTEMPTS) return SLOW_MS;
  return STEPS_MS[Math.min(n, STEPS_MS.length - 1)];
}
