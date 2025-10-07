# roblox-cookie-fetcher
Custom web scraper for fetching a Roblox account's cookie, given you have the account's username and password which should be put in a `.env` file. (see `.example.env` for example)

If you get hit with the CAPTCHA error, you'll need to first manually sign in via a browser before trying again a few minutes later with the container.

> **⚠️Disclaimer:** Do not use for malicous or illegal intent. This is only meant to be used to set up a service account using a Roblox account you own or have legal/authorized access to.

Run with:
```
npm run fetch
```
---
Personally, I used this as follows:
- Upload as (private) Docker image and upload to artifact registry on Google Cloud Platform (GCP)
- Use Docker image to create a GCP Cloud Run Job
- Connect Cloud Run Job to a VPC Network for outbound traffic
  - Serverless APC Access connector > Select your created VPC Network and select "Route all traffic to the VPC"
- The project that needs the Cookie goes through a similar process (create a VM, Cloud Run Service, etc.)
- Make sure that the Cloud Run Service or Virtual Machine is using the same VPC Network as the Cloud Run Job was on when fetching the cookie.
- Grab cookie from Cloud Run Job's logs
- Add copied cookie as enviornment variable in the Cloud Run Service or Virtual Machine
- Delete logs or limit access to the job's logs to make sure no one else can grab it in plain text after
- Profit
