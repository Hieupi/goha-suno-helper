// Dev-only Local Network Access probe: can an extension page reach 127.0.0.1 by fetch and by
// WebSocket on this Chrome build? Results are shown on the page and copied into the spike report.
const PORT = 47899;
const out = document.getElementById("out");

function show(label, ok, detail) {
  const li = document.createElement("li");
  li.className = ok ? "ok" : "bad";
  li.textContent = `${ok ? "ĐƯỢC" : "BỊ CHẶN / LỖI"} — ${label}: ${detail}`;
  out.append(li);
}

async function probeFetch() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/probe`);
    show("fetch http://127.0.0.1", response.ok, `${response.status} ${(await response.text()).trim()}`);
  } catch (error) {
    show("fetch http://127.0.0.1", false, String(error));
  }
}

function probeWebSocket() {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const timer = setTimeout(() => { show("WebSocket ws://127.0.0.1", false, "hết 5 s không mở được"); socket.close(); resolve(); }, 5000);
    socket.onopen = () => socket.send("ping");
    socket.onmessage = (event) => { clearTimeout(timer); show("WebSocket ws://127.0.0.1", true, String(event.data)); socket.close(); resolve(); };
    socket.onerror = () => { clearTimeout(timer); show("WebSocket ws://127.0.0.1", false, "onerror"); resolve(); };
  });
}

document.getElementById("run").addEventListener("click", async () => {
  out.replaceChildren();
  show("Chrome", true, navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent);
  await probeFetch();
  await probeWebSocket();
});
