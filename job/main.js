import puppeteer from "puppeteer-extra";
import { configDotenv } from "dotenv";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { ServicesClient } from "@google-cloud/run";

configDotenv();

const runHeadless = process.env.RUN_HEADLESS !== "false";
const username = process.env.ROBLOX_USER;
const password = process.env.ROBLOX_PASS;

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const COOKIE_SERVICE_NAME = process.env.COOKIE_SERVICE_NAME;
const COOKIE_SERVICE_REGION = process.env.COOKIE_SERVICE_REGION || "europe-west1";
const SECRET_NAME = process.env.SECRET_NAME || "api-roblox-token";

puppeteer.use(StealthPlugin());

const secretClient = new SecretManagerServiceClient();
const runClient = new ServicesClient();

// ── Cloud Run scaling ─────────────────────────────────────────
async function setServiceScale(minInstances) {
  const name = `projects/${GCP_PROJECT_ID}/locations/${COOKIE_SERVICE_REGION}/services/${COOKIE_SERVICE_NAME}`;
  console.log(`[RUN] Setting ${COOKIE_SERVICE_NAME} minInstances → ${minInstances}`);

  const [service] = await runClient.getService({ name });
  service.template.scaling = { minInstanceCount: minInstances };

  const [operation] = await runClient.updateService({ service });
  const [updated] = await operation.promise();
  console.log(`[RUN] Service updated, uri: ${updated.uri}`);
  return updated.uri;
}

async function waitForServiceReady(uri, timeoutMs = 60000) {
  const start = Date.now();
  console.log("[RUN] Waiting for service to be ready...");
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${uri}/health`);
      if (res.ok) { console.log(`[RUN] Service is ready at ${uri}.`); return; }
    } catch { }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timed out waiting for webhook service to become ready");
}

// ── Secret Manager ────────────────────────────────────────────
async function writeCookieToSecret(cookieValue) {
  const secretPath = `projects/${GCP_PROJECT_ID}/secrets/${SECRET_NAME}`;
  console.log(`[SECRET] Writing new version to ${secretPath}`);
  const [version] = await secretClient.addSecretVersion({
    parent: secretPath,
    payload: { data: Buffer.from(cookieValue, "utf8") },
  });
  console.log(`[SECRET] Written: ${version.name}`);
}

// ── Captcha helpers ───────────────────────────────────────────
async function pollForToken(tokenPollUrl, intervalMs = 3000, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const res = await fetch(tokenPollUrl);
      const { token } = await res.json();
      if (token) return token;
    } catch (err) {
      console.error("[POLL] Error:", err.message);
    }
  }
  throw new Error("CAPTCHA token polling timed out");
}

async function sendScreenshot(page, webhookBase) {
  try {
    const screenshot = await page.screenshot({ type: "png", fullPage: false });
    const res = await fetch(`${webhookBase}/captcha-screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: screenshot,
    });
    if (res.status !== 200) console.warn("[RELAY] Screenshot POST status:", res.status);
  } catch (err) {
    console.error("[RELAY] Screenshot error:", err.message);
  }
}

async function drainClicks(page, webhookBase) {
  try {
    const res = await fetch(`${webhookBase}/captcha-clicks`);
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

// ── Main ──────────────────────────────────────────────────────
(async () => {
  let browser;
  let serviceScaledUp = false;

  async function cleanup() {
    if (serviceScaledUp) {
      try {
        await setServiceScale(0);
        console.log("[RUN] Service scaled back to 0.");
      } catch (err) {
        console.error("[RUN] Failed to scale down service:", err.message);
      }
    }
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
    console.log("[INIT] runHeadless:", runHeadless);
    console.log("[INIT] GCP_PROJECT_ID:", GCP_PROJECT_ID);
    console.log("[INIT] COOKIE_SERVICE_NAME:", COOKIE_SERVICE_NAME);
    console.log("[INIT] COOKIE_SERVICE_REGION:", COOKIE_SERVICE_REGION);
    console.log("[INIT] SECRET_NAME:", SECRET_NAME);

    if (!username || !password) {
      console.error("[INIT] Missing ROBLOX_USER or ROBLOX_PASS");
      process.exitCode = 9;
      return;
    }
    if (!GCP_PROJECT_ID || !COOKIE_SERVICE_NAME) {
      console.error("[INIT] Missing GCP_PROJECT_ID or COOKIE_SERVICE_NAME");
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
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

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
    await page.goto("https://www.roblox.com/login", { waitUntil: "networkidle2" });
    console.log("[NAV] Loaded:", page.url());

    console.log("[LOGIN] Typing credentials...");
    await page.type("#login-username", username, { delay: 80 });
    await page.type("#login-password", password, { delay: 80 });
    await page.keyboard.press("Enter");
    console.log("[LOGIN] Submitted");

    await new Promise((r) => setTimeout(r, 2000));

    console.log("[WAIT] Waiting for /home or CAPTCHA...");
    let raceResult;
    try {
      raceResult = await Promise.race([
        page
          .waitForFunction("window.location.href.includes('/home')", { timeout: 300000 })
          .then(() => "home"),
        page
          .waitForSelector("div[role='dialog'] iframe[src*='arkoselabs']", { timeout: 300000 })
          .then(() => "captcha"),
        page
          .waitForSelector("iframe[src*='arkoselabs']", { timeout: 300000 })
          .then(() => "captcha-bare"),
      ]);
    } catch (err) {
      console.error("[WAIT] Timed out:", err.message);
      throw err;
    }

    console.log("[WAIT] Race resolved:", raceResult);

    if (raceResult === "home") {
      console.log("[LOGIN] Logged in without CAPTCHA.");
    } else {
      console.log("[CAPTCHA] Detected! Scaling up webhook service...");

      const serviceUri = await setServiceScale(1);
      serviceScaledUp = true;
      await waitForServiceReady(serviceUri);

      const webhookUrl = `${serviceUri}/captcha-token`;
      const tokenPollUrl = `${serviceUri}/captcha-token/latest`;

      console.log("[CAPTCHA] Solver UI:", `${serviceUri}/solve`);

      // Set up postMessage interception now that we have the service URI
      await page.evaluateOnNewDocument((wUrl) => {
        window.addEventListener("message", (e) => {
          const token = e.data?.token || e.data?.data?.token || e.data?.ark_token;
          if (token && typeof token === "string" && token.length > 20) {
            navigator.sendBeacon(wUrl, JSON.stringify({ token }));
          }
        }, true);
      }, webhookUrl);

      let solved = false;
      const relay = setInterval(async () => {
        if (solved) return;
        await sendScreenshot(page, serviceUri);
        await drainClicks(page, serviceUri);
      }, 500);

      const homeReached = page
        .waitForFunction("window.location.href.includes('/home')", { timeout: 15 * 60 * 1000 })
        .then(() => "home")
        .catch(() => null);

      const tokenReceived = pollForToken(tokenPollUrl)
        .then((tok) => ({ type: "token", value: tok }))
        .catch(() => null);

      const result = await Promise.race([homeReached, tokenReceived]);
      solved = true;
      clearInterval(relay);

      if (result === "home") {
        console.log("[CAPTCHA] Page navigated to /home after solve, skipping injection.");
      } else if (result?.type === "token") {
        console.log("[CAPTCHA] Token received, injecting...");
        await page.evaluate((tok) => {
          if (window.enforcement?.setToken) {
            window.enforcement.setToken(tok);
          } else if (window.arkoseEnforcement?.setToken) {
            window.arkoseEnforcement.setToken(tok);
          } else {
            const input = document.querySelector(
              '#arkose-token, input[name="captchaToken"], input[name*="captcha"], input[id*="arkose"]'
            );
            if (input) {
              input.value = tok;
              input.dispatchEvent(new Event("change", { bubbles: true }));
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
        }, result.value);

        console.log("[CAPTCHA] Injected, waiting for /home...");
        await page.waitForFunction("window.location.href.includes('/home')", { timeout: 60000 });
      } else {
        throw new Error("CAPTCHA solve timed out — neither token nor /home redirect received");
      }
    }

    console.log("[SUCCESS] Grabbing cookie...");
    const client = await page.createCDPSession();
    const { cookies } = await client.send("Network.getAllCookies");
    const securityCookie = cookies.find((c) => c.name === ".ROBLOSECURITY");

    if (securityCookie) {
      await writeCookieToSecret(securityCookie.value);
      console.log("[COOKIE] Written to Secret Manager successfully.");
      process.exitCode = 0;
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