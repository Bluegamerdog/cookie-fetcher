import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { configDotenv } from "dotenv";

configDotenv();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "100kb" }));
app.use(express.text({ type: "text/plain", limit: "100kb" }));

let latestScreenshot = null;
const pendingClicks = [];
let pendingTwoFactorCode = null;
const wsClients = new Set();

// ── WebSocket ────────────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  wsClients.add(ws);
  console.log("[WS] Client connected, total:", wsClients.size);

  if (latestScreenshot) {
    ws.send(JSON.stringify({ type: "screenshot", data: latestScreenshot }));
  }

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);

      if (parsed.type === "click") {
        if (
          typeof parsed.x !== "number" ||
          typeof parsed.y !== "number" ||
          !Number.isFinite(parsed.x) ||
          !Number.isFinite(parsed.y)
        ) {
          console.warn("[WS] Invalid click payload");
          return;
        }

        console.log("[WS] Click received:", parsed.x, parsed.y);
        pendingClicks.push({ x: parsed.x, y: parsed.y });
      }

      if (parsed.type === "twoFactorCode") {
        if (
          typeof parsed.value !== "string" ||
          !/^[0-9]{4,8}$/.test(parsed.value)
        ) {
          console.warn("[WS] Invalid 2FA payload");
          return;
        }

        console.log("[WS] 2FA code received:", parsed.value.length, "digits");
        pendingTwoFactorCode = parsed.value;
      }
    } catch (err) {
      console.error("[WS] Bad message:", err.message);
    }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
    console.log("[WS] Client disconnected, total:", wsClients.size);
  });

  ws.on("error", (err) => console.error("[WS] Error:", err.message));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  let sent = 0;

  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
      sent++;
    }
  }

  console.log("[WS] Broadcast:", msg.type, "→", sent, "clients");
}

// ── Screenshot ───────────────────────────────────────────────────────────────
app.post(
  "/captcha-screenshot",
  express.raw({ type: "application/octet-stream", limit: "5mb" }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      console.warn("[SCREENSHOT] Empty body");
      return res.sendStatus(400);
    }
    latestScreenshot = req.body.toString("base64");
    console.log("[SCREENSHOT]", req.body.length, "bytes →", wsClients.size, "clients");
    broadcast({ type: "screenshot", data: latestScreenshot });
    res.sendStatus(200);
  }
);

app.get("/captcha-clicks", (_req, res) => {
  const clicks = pendingClicks.splice(0);
  if (clicks.length) console.log("[CLICKS] Draining:", clicks);
  res.json({ clicks });
});

app.get("/two-factor-code", (_req, res) => {
  const code = pendingTwoFactorCode;
  pendingTwoFactorCode = null;

  if (code) {
    console.log("[2FA] Draining code:", code.length, "digits");
  }

  res.json({ code });
});

app.post("/captcha-solved", (_req, res) => {
  console.log("[SOLVED] Solver marked as solved");
  broadcast({ type: "solved" });
  res.sendStatus(200);
});

app.post("/captcha-reset", (_req, res) => {
  pendingClicks.splice(0);
  pendingTwoFactorCode = null;
  latestScreenshot = null;
  console.log("[RESET] Cleared pending clicks and screenshot");
  broadcast({ type: "reset" });
  res.sendStatus(200);
});

// ── Solver UI ────────────────────────────────────────────────────────────────
app.get("/solve", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Solve CAPTCHA</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      font-family: sans-serif;
      color: white;
      gap: 16px;
    }
    h2 { font-size: 18px; opacity: 0.8; }
    #wrapper { position: relative; cursor: crosshair; }
    #canvas {
      border-radius: 8px;
      display: block;
      max-width: 90vw;
      max-height: 80vh;
    }
    #status { font-size: 14px; opacity: 0.6; }
    #status.success { color: #4ade80; opacity: 1; font-weight: bold; }
    #debug { font-size: 11px; opacity: 0.4; font-family: monospace; }
    .click-dot {
      position: fixed;
      width: 12px;
      height: 12px;
      background: red;
      border: 2px solid white;
      border-radius: 50%;
      pointer-events: none;
      transform: translate(-50%, -50%);
      animation: fade 0.6s forwards;
      z-index: 9999;
    }
    #twoFactorBox {
      display: flex;
      gap: 8px;
    }
    #twoFactorCode {
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid #555;
      background: #0f0f1f;
      color: white;
    }
    #sendTwoFactor {
      padding: 8px 12px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
    }
    @keyframes fade {
      0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(2); }
    }
  </style>
</head>
<body>
  <h2>Click to solve the CAPTCHA</h2>
  <div id="wrapper">
    <canvas id="canvas"></canvas>
  </div>
  <p id="status">Connecting...</p>
  <p id="debug"></p>
  <div id="twoFactorBox">
    <input
      id="twoFactorCode"
      inputmode="numeric"
      pattern="[0-9]*"
      maxlength="8"
      placeholder="2FA code"
    />
    <button id="sendTwoFactor">Send 2FA</button>
  </div>
  <script>
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const status = document.getElementById('status');
    const debug = document.getElementById('debug');

    function log(msg) {
      console.log(msg);
      debug.textContent = msg;
    }

    function showClickDot(clientX, clientY) {
      const dot = document.createElement('div');
      dot.className = 'click-dot';
      dot.style.left = clientX + 'px';
      dot.style.top = clientY + 'px';
      document.body.appendChild(dot);
      setTimeout(() => dot.remove(), 600);
    }

    const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);

    ws.onopen = () => {
      status.textContent = 'Waiting for CAPTCHA screenshot...';
      log('WS connected');
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        log('Bad WS message');
        return;
      }

      log('WS: ' + msg.type);

      if (msg.type === 'screenshot') {
        const img = new Image();
        img.onload = () => {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
          status.textContent = 'Click to solve';
          status.className = '';
          log('Frame: ' + img.width + 'x' + img.height);
        };
        img.onerror = () => log('Image decode failed');
        img.src = 'data:image/png;base64,' + msg.data;
      }

      if (msg.type === 'solved') {
        status.textContent = '✅ Solved! You can close this tab.';
        status.className = 'success';
      }

      if (msg.type === 'reset') {
        status.textContent = 'Waiting for CAPTCHA screenshot...';
        status.className = '';
      }
    };

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);

      log('Click → ' + x + ', ' + y + ' (scale ' + scaleX.toFixed(2) + 'x' + scaleY.toFixed(2) + ')');
      showClickDot(e.clientX, e.clientY);
      ws.send(JSON.stringify({ type: 'click', x, y }));
    });

    ws.onerror = (e) => {
      log('WS error');
      console.error(e);
    };

    ws.onclose = () => {
      status.textContent = 'Disconnected — refresh to reconnect.';
      log('WS closed');
    };
    document.getElementById('sendTwoFactor').addEventListener('click', () => {
      const input = document.getElementById('twoFactorCode');
      const value = input.value.trim();

      if (!/^[0-9]{4,8}$/.test(value)) {
        status.textContent = 'Invalid 2FA code';
        return;
      }

      ws.send(JSON.stringify({ type: 'twoFactorCode', value }));
      input.value = '';
      status.textContent = '2FA code sent';
    });
  </script>
</body>
</html>`);
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

server.listen(PORT, () => console.log(`[WEBHOOK] Listening on :${PORT}`));