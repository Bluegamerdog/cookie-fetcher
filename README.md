# roblox-cookie-fetcher
Custom web scraper for fetching a Roblox account's cookie, __given you have the account's username and password__ which should be put in a `.env` file. (see `.example.env` for example)

If you get hit with the CAPTCHA error, you'll need to first manually sign in via a browser before trying again a few minutes later with the container.

> **⚠️Disclaimer:** Do not use for malicous or illegal intent. This is only meant to be used to set up a service account using a Roblox account you own or have legal/authorized access to.

Run with:
```
npm run fetch
```
`job/main.js` runs once, does the login/fetch flow described above, and exits — it's meant to be triggered on demand (e.g. by scipnet-api's cookie bridge, which turns it on once per refresh and lets it finish on its own) rather than run continuously. `service/server.js` is the opposite: it's meant to stay running permanently as the always-on relay/status endpoint `job` reports to (`COOKIE_SERVICE_URL`) and, if a CAPTCHA comes up, the webhook a human solves it through.

---
Personally, I used this as follows:
- Upload as (private) Docker images and upload to artifact registry on Google Cloud Platform (GCP)
- Use the `service` image to create a GCP Cloud Run **Service** that stays up (not scaled to zero — `job` and any callers need it reachable at all times)
- Use the `job` image to create a GCP Cloud Run **Job** — it runs to completion and stops on its own each time it's executed
- Connect both to a VPC Network for outbound traffic
  - Serverless VPC Access connector > Select your created VPC Network and select "Route all traffic to the VPC"
- The project that needs the cookie goes through a similar process (create a VM, Cloud Run Service, etc.)
- Make sure that consumer is using the same VPC Network `job` is on when fetching the cookie
- `job` writes the cookie straight to Secret Manager (`SECRET_NAME`) on success — no need to copy it out of logs
- Grant the consumer's service account access to read that secret
