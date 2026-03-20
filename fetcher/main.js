import puppeteer from "puppeteer-extra";
import { configDotenv } from "dotenv";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

configDotenv();

const runHeadless = process.env.RUN_HEADLESS !== "false";
const username = process.env.ROBLOX_USER;
const password = process.env.ROBLOX_PASS;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const TOKEN_POLL_URL = process.env.TOKEN_POLL_URL;
const WEBHOOK_BASE = WEBHOOK_URL?.replace("/captcha-token", "");

puppeteer.use(StealthPlugin());

async function pollForToken(intervalMs = 3000, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const res = await fetch(TOKEN_POLL_URL);
      const { token } = await res.json();
      if (token) return token;
    } catch (err) {
      console.error("[POLL] Error:", err.message);
    }
  }
  throw new Error("CAPTCHA token polling timed out");
}

async function sendScreenshot(page) {
  try {
    const screenshot = await page.screenshot({ type: "png", fullPage: false });
    const res = await fetch(`${WEBHOOK_BASE}/captcha-screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: screenshot,
    });
    if (res.status !== 200)
      console.warn("[RELAY] Screenshot POST status:", res.status);
  } catch (err) {
    console.error("[RELAY] Screenshot error:", err.message);
  }
}

async function drainClicks(page) {
  try {
    const res = await fetch(`${WEBHOOK_BASE}/captcha-clicks`);
    const { clicks } = await res.json();
    for (const { x, y } of clicks) {
      console.log("[RELAY] Click:", x, y);
      await page.mouse.move(x, y, { steps: 5 });
      await new Promise((r) => setTimeout(r, 80));
      await page.mouse.click(x, y, { delay: 60 });
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch (err) {
    console.error("[RELAY] Click error:", err.message);
  }
}

(async () => {
  let browser;

  async function cleanup() {
    if (browser) {
      try {
        await browser.close();
        console.log("[CLEANUP] Browser closed.");
      } catch (err) {
        console.error("[CLEANUP] Failed:", err.message);
      }
    }
  }

  try {
    console.log("[INIT] WEBHOOK_BASE:", WEBHOOK_BASE);
    console.log("[INIT] TOKEN_POLL_URL:", TOKEN_POLL_URL);
    console.log("[INIT] runHeadless:", runHeadless);

    if (!username || !password) {
      console.error("[INIT] Missing ROBLOX_USER or ROBLOX_PASS");
      process.exitCode = 9;
      return;
    }
    if (!WEBHOOK_URL || !TOKEN_POLL_URL) {
      console.error("[INIT] Missing WEBHOOK_URL or TOKEN_POLL_URL");
      process.exitCode = 9;
      return;
    }

    console.log("[BROWSER] Launching...");
    browser = await puppeteer.launch({
      headless: runHeadless,
      args: [
        "--incognito",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();

    // Fixed viewport so screenshot coords match mouse coords 1:1
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    // Intercept postMessage token — must be before goto
    await page.evaluateOnNewDocument((webhookUrl) => {
      window.addEventListener(
        "message",
        (e) => {
          const token =
            e.data?.token || e.data?.data?.token || e.data?.ark_token;
          if (token && typeof token === "string" && token.length > 20) {
            navigator.sendBeacon(webhookUrl, JSON.stringify({ token }));
          }
        },
        true,
      );
    }, WEBHOOK_URL);

    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("arkoselabs") || url.includes("arkose")) {
        console.log("[REQUEST]", url);
      }
    });

    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("arkoselabs") || url.includes("arkose")) {
        console.log("[RESPONSE]", url, "→", res.status());
      }
    });

    page.on("console", (msg) => console.log("[PAGE]", msg.type(), msg.text()));
    page.on("pageerror", (err) => console.error("[PAGE ERROR]", err.message));

    console.log("[NAV] Going to roblox.com/login...");
    await page.goto("https://www.roblox.com/login", {
      waitUntil: "networkidle2",
    });
    console.log("[NAV] Loaded:", page.url());

    await page.screenshot({ path: "before-login.png" });
    console.log("[DEBUG] Saved before-login.png");

    console.log("[LOGIN] Typing credentials...");
    await page.type("#login-username", username, { delay: 80 });
    await page.type("#login-password", password, { delay: 80 });
    await page.keyboard.press("Enter");
    console.log("[LOGIN] Submitted");

    await new Promise((r) => setTimeout(r, 2000));
    await page.screenshot({ path: "after-submit.png" });
    console.log("[DEBUG] Saved after-submit.png, URL:", page.url());
    console.log(
      "[DEBUG] Frames:",
      page.frames().map((f) => f.url()),
    );

    console.log("[WAIT] Waiting for /home or CAPTCHA...");
    let raceResult;
    try {
      raceResult = await Promise.race([
        page
          .waitForFunction("window.location.href.includes('/home')", {
            timeout: 300000,
          })
          .then(() => "home"),
        page
          .waitForSelector("div[role='dialog'] iframe[src*='arkoselabs']", {
            timeout: 300000,
          })
          .then(() => "captcha"),
        page
          .waitForSelector("iframe[src*='arkoselabs']", { timeout: 300000 })
          .then(() => "captcha-bare"),
      ]);
    } catch (err) {
      console.error("[WAIT] Timed out:", err.message);
      await page.screenshot({ path: "race-timeout.png" });
      throw err;
    }

    console.log("[WAIT] Race resolved:", raceResult);
    await page.screenshot({ path: "race-resolved.png" });
    console.log("[DEBUG] URL:", page.url());
    console.log(
      "[DEBUG] Frames:",
      page.frames().map((f) => f.url()),
    );

    if (raceResult === "home") {
      console.log("[LOGIN] Logged in without CAPTCHA.");
    } else {
      console.log("[CAPTCHA] Detected! Solver:", `${WEBHOOK_BASE}/solve`);

      let solved = false;

      const relay = setInterval(async () => {
        if (solved) return;
        await sendScreenshot(page);
        await drainClicks(page);
      }, 500);

      // Watch for navigation to /home in parallel with token polling
      const homeReached = page
        .waitForFunction("window.location.href.includes('/home')", {
          timeout: 15 * 60 * 1000,
        })
        .then(() => "home")
        .catch(() => null);

      const tokenReceived = pollForToken()
        .then((tok) => ({ type: "token", value: tok }))
        .catch(() => null);

      const result = await Promise.race([homeReached, tokenReceived]);
      solved = true;
      clearInterval(relay);

      if (result === "home") {
        // Arkose auto-submitted after solving — skip injection, go straight to cookie
        console.log(
          "[CAPTCHA] Page navigated to /home after solve, skipping injection.",
        );
      } else if (result?.type === "token") {
        console.log("[CAPTCHA] Token received, injecting...");
        await page.evaluate((tok) => {
          if (window.enforcement?.setToken) {
            window.enforcement.setToken(tok);
          } else if (window.arkoseEnforcement?.setToken) {
            window.arkoseEnforcement.setToken(tok);
          } else {
            const input = document.querySelector(
              '#arkose-token, input[name="captchaToken"], input[name*="captcha"], input[id*="arkose"]',
            );
            if (input) {
              input.value = tok;
              input.dispatchEvent(new Event("change", { bubbles: true }));
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
        }, result.value);

        console.log("[CAPTCHA] Injected, waiting for /home...");
        await page.waitForFunction("window.location.href.includes('/home')", {
          timeout: 60000,
        });
      } else {
        throw new Error(
          "CAPTCHA solve timed out — neither token nor /home redirect received",
        );
      }
    }

    console.log("[SUCCESS] Grabbing cookie...");
    const client = await page.createCDPSession();
    const { cookies } = await client.send("Network.getAllCookies");
    const securityCookie = cookies.find((c) => c.name === ".ROBLOSECURITY");

    if (securityCookie) {
      console.warn("[COOKIE] ROBLOSECURITY:", securityCookie.value);
      process.exitCode = 200;
    } else {
      console.error("[COOKIE] Not found!");
      process.exitCode = 4;
    }
  } catch (err) {
    console.error("[ERROR]", err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
    console.log("[EXIT] Code:", process.exitCode);
  }
})();
