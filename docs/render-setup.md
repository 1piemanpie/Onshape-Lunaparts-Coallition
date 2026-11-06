# Render setup

[Render](https://render.com) runs the server. The team uses the **free**
plan. Merging into `master` on GitHub deploys the new code automatically.

The live service is called **onshape-lunaparts-coallition**, at
`https://onshape-lunaparts-coallition.onrender.com`. Don't rename it: the name
is part of the address, and Onshape's OAuth app and extensions point at that
address.

## 1. Create the web service (only once)

Skip this if the service already exists.

1. Go to https://dashboard.render.com and sign in with GitHub.
2. Click **New +**, then **Web Service**.
3. Pick the GitHub repo **Onshape-Lunaparts-Coallition**. If it isn't listed,
   click **Configure account** and give Render access to it.
4. Fill in:
   - **Name:** `onshape-lunaparts-coallition`
   - **Branch:** `master`
   - **Runtime / Language:** Node
   - **Build Command:** `npm ci` (installs the exact versions in
     `package-lock.json`; `npm install` also works)
   - **Start Command:** `npm start`
   - **Instance Type:** **Free**
5. Add the environment variables from the next step on the same page (or later
   under **Environment**).
6. Click **Create Web Service**. The first deploy takes a few minutes.

## 2. Add the environment variables

Open the service, click **Environment** on the left, and add these. Click
**Save changes** when done; Render restarts the server.

| Key | Value |
|---|---|
| `ONSHAPE_CLIENT_ID` | The Client ID from the Onshape OAuth app ([Onshape setup](onshape-setup.md)) |
| `ONSHAPE_CLIENT_SECRET` | The Client secret from the same app |
| `SESSION_SECRET` | Click **Generate** to let Render make a random value |
| `LUNA_PARTS_API_KEY` | A LUNA Parts API token. Its LUNA user needs **editor** access. Ask the person who runs LUNA Parts where to make one. |
| `LUNA_PARTS_API_BASE` | Optional. Leave it out to use `https://build.lunatecs.org/api/v1`. |

These values are secrets. Type or paste them only into Render. Never into the
code, a GitHub comment, chat, or Discord. Changing `SESSION_SECRET` logs
everyone out of the panel once.

## 3. Health check and keeping it awake

The server answers `ok` at `/health`.

- In the service's **Settings**, set **Health Check Path** to `/health`.
- Free services go to sleep after about 15 minutes with no visits, and the
  first panel load after that takes up to a minute. The team keeps it awake
  with a free [UptimeRobot](https://uptimerobot.com) monitor that visits
  `https://onshape-lunaparts-coallition.onrender.com/health` every 5 minutes.
  To make one: **Add New Monitor**, type **HTTP(s)**, paste that address,
  interval **5 minutes**, **Create Monitor**.
- If it ever isn't enough, Render's paid Starter plan never sleeps (about
  $7 a month). That costs money, so ask before switching.

## Deploys

- Every merge into `master` starts a deploy. Watch it under **Events** or
  **Logs**. "Your service is live" means it's done.
- A deploy restarts the server. Its memory is wiped, so the caches start
  empty and the next few panel actions use a few more Onshape calls. Merging
  several pull requests together, instead of one at a time, saves calls.
- If a deploy breaks something, open **Events**, find the last good deploy,
  and click **Rollback** (or revert the pull request on GitHub).

## Reading the logs

Click **Logs** on the service. Useful lines:

- `Luna Parts Bridge listening on port ...`: the server started.
- `[onshape calls] GET /api/onshape/parts: 2 (130 since the server started)`:
  how many Onshape calls each panel action used.
- `LUNA Parts ... returned 401`: the LUNA key is wrong or expired.
- `Onshape ... returned 402`: Onshape's yearly call allowance is used up (see
  [Onshape setup](onshape-setup.md#when-something-goes-wrong)).

The logs never print the secrets.

## Reference

- Render web services: https://render.com/docs/web-services
- Deploying a Node/Express app: https://render.com/docs/deploy-node-express-app
- Environment variables: https://render.com/docs/configure-environment-variables
- Health checks: https://render.com/docs/health-checks
- Free plan limits: https://render.com/docs/free
