import puppeteer from "puppeteer-extra";
import { configDotenv } from "dotenv";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import capsolver from "capsolver-npm";

configDotenv();

const runHeadless = process.env.RUN_HEADLESS;
const username = process.env.ROBLOX_USER;
const password = process.env.ROBLOX_PASS;
const capsolverKey = process.env.CAPSOLVER_API_KEY;

// Roblox's Arkose public key (stable, but double-check if login breaks in future)
const ROBLOX_ARKOSE_PUBLIC_KEY = "476068BF-9607-4799-B53D-966BE98E2B81"; // fix

puppeteer.use(StealthPlugin());

async function solveArkose() {
  capsolver.apiKey = capsolverKey;

  const solution = await capsolver.solve({
    type: "FunCaptchaTask",
    websiteURL: "https://www.roblox.com/login",
    websitePublicKey: ROBLOX_ARKOSE_PUBLIC_KEY,
    // No proxy field = CapSolver uses their own residential IPs for solving
  });

  return solution.token;
}

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

    if (!capsolverKey) {
      console.error("Set CAPSOLVER_API_KEY environment variable!");
      process.exitCode = 9;
      return;
    }

    console.log("Starting browser...");

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

    await page.setExtraHTTPHeaders({
      "accept-language": "en-US,en;q=0.9",
    });

    // Warm up: visit homepage first before going to login
    console.log("Warming up...");
    await page.goto("https://www.roblox.com", { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));

    console.log("Navigated to https://www.roblox.com/login...");
    await page.goto("https://www.roblox.com/login", {
      waitUntil: "networkidle2",
    });

    await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
    await page.type("#login-username", username, {
      delay: 80 + Math.random() * 40,
    });
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
    await page.type("#login-password", password, {
      delay: 80 + Math.random() * 40,
    });
    await page.focus("#login-password");
    await page.keyboard.press("Enter");

    console.log("Submitted login form...");

    // Wait for home page or CAPTCHA
    await Promise.race([
      page.waitForFunction("window.location.href.includes('/home')", {
        timeout: 300000,
      }),
      page.waitForSelector("div[role='dialog'] iframe[src*='arkoselabs']", {
        timeout: 300000,
      }),
    ]);

    // Detect CAPTCHA
    const captchaVisible = await page.$(
      "div[role='dialog'] iframe[src*='arkoselabs']",
    );

    if (captchaVisible) {
      const arkosePublicKey = await page.evaluate(() => {
        const iframe = document.querySelector("iframe[src*='arkoselabs']");
        if (!iframe) return null;
        const url = new URL(iframe.src);
        return url.searchParams.get("pk");
      });

      if (!arkosePublicKey) {
        console.error("Could not extract Arkose public key from iframe!");
        process.exitCode = 2;
        return;
      }

      console.log("Extracted Arkose public key:", arkosePublicKey);
      console.log("Arkose CAPTCHA detected, solving via CapSolver...");

      let token;
      try {
        token = await solveArkose();
        console.log("Got Arkose token, injecting...");
      } catch (err) {
        console.error("CapSolver failed:", err);
        process.exitCode = 2;
        return;
      }

      // Inject the token into the Arkose iframe and submit
      await page.evaluate((solvedToken) => {
        // Roblox reads the token from this callback
        if (window.ArkoseEnforcement) {
          window.ArkoseEnforcement.run(solvedToken);
        } else {
          // Fallback: dispatch the enforcement callback Roblox registers
          const enforcement = document.querySelector(
            "iframe[src*='arkoselabs']",
          );
          if (enforcement && enforcement.contentWindow) {
            enforcement.contentWindow.postMessage(
              JSON.stringify({
                eventId: "challenge-complete",
                payload: { sessionToken: solvedToken },
              }),
              "*",
            );
          }
        }
      }, token);

      console.log("Token injected, waiting for redirect...");

      // Wait for login to complete after token injection
      await page.waitForFunction("window.location.href.includes('/home')", {
        timeout: 60000,
      });
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
