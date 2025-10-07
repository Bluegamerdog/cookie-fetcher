import puppeteer from "puppeteer";
import { configDotenv } from "dotenv";

configDotenv();

const runHeadless = process.env.RUN_HEADLESS;
const username = process.env.ROBLOX_USER;
const password = process.env.ROBLOX_PASS;

(async () => {
  let browser;

  async function cleanup() {
    if (browser) {
      try {
        await browser.close();
        console.log("Browser closed.");
      } catch (error) {
        console.error("Failed to run browser.close():", error);
      }
    }
  }

  try {
    if (!username || !password) {
      console.error("Set ROBLOX_USER and ROBLOX_PASS environment variables!");
      process.exitCode = 9;
      return;
    }

    console.log("Starting browser...");

    browser = await puppeteer.launch({
      headless: runHeadless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    const page = await browser.newPage();

    console.log("Navigated to https://www.roblox.com/login...");
    await page.goto("https://www.roblox.com/login", {
      waitUntil: "networkidle2",
    });

    await page.type("#login-username", username);
    await page.type("#login-password", password);
    await page.focus("#login-password");
    await page.keyboard.press("Enter");

    console.log("Submitted login form...");

    // Wait for home page or CAPTCHA
    await Promise.race([
      page.waitForFunction("window.location.href.includes('/home')", {
        timeout: 300000, // 5 Minutes
      }),
      page.waitForSelector("div[role='dialog'] iframe[src*='arkoselabs']", {
        timeout: 300000, // 5 Minutes
      }),
    ]);

    // Detect CAPTCHA
    const captchaVisible = await page.$(
      "div[role='dialog'] iframe[src*='arkoselabs']"
    );
    if (captchaVisible) {
      console.error("Arkose CAPTCHA detected! Manual intervention required.");
      process.exitCode = 2;
      return;
    }

    console.log("Logged in successfully...");

    const client = await page.createCDPSession();
    const allCookies = (await client.send("Network.getAllCookies")).cookies;
    const securityCookie = allCookies.find((c) => c.name === ".ROBLOSECURITY");

    if (securityCookie) {
      console.warn("ROBLOSECURITY cookie:", securityCookie.value);
      process.exitCode = 200;
    } else {
      console.error("ROBLOSECURITY cookie not found!");
      process.exitCode = 4;
    }
  } catch (err) {
    console.error("Unexpected error:", err);
    process.exitCode = 1;
  } finally {
    await cleanup();
    console.log("Process exited with code:", process.exitCode);
  }
})();
