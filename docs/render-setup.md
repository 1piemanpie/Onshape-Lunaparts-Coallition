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
| `REDIS_URL` | Optional, but recommended: keeps people logged in across deploys. See [step 4](#4-keep-logins-across-restarts-render-key-value-free). |

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

## 4. Keep logins across restarts (Render Key Value, free)

Without this, the server keeps logins in its own memory, so every deploy or
restart logs everyone out of the panel. A Render **Key Value** instance (Render's
name for Redis) keeps them outside the server instead. The free one is enough:
each login takes about 1 KB.

The code is already in place. It does nothing until `REDIS_URL` is set, so
it's fine to merge first and do these steps later.

1. Check which **region** the web service is in: open
   **onshape-lunaparts-coallition**, then **Settings**, and look for
   **Region** (for example Oregon or Ohio).
2. In the dashboard, click **New +**, then **Key Value**.
3. Fill in:
   - **Name:** `luna-bridge-sessions`
   - **Region:** the **same** region as the web service. The private address
     used below only works inside one region.
   - **Maxmemory Policy:** `allkeys-lru` if it asks. If it ever fills up, the
     oldest logins are dropped and those people just log in again.
   - **Instance Type / Plan:** **Free**. Don't pick a paid plan; ask first if
     Render ever suggests one.
4. Click **Create Key Value** and wait until its status says **Available**.
5. On the new Key Value's page, click **Connect** (top right), choose the
   **Internal** tab, and copy the **Internal Key Value URL**. It looks like
   `redis://red-xxxxxxxxxxxx:6379`. Use the internal one, not the external one
   that starts with `rediss://`.
6. Open the web service, click **Environment**, then **Add Environment
   Variable**:
   - **Key:** `REDIS_URL`
   - **Value:** the address you copied
7. Click **Save changes**. Render restarts the server (about a minute).
8. Open **Logs**. You should see
   `Connected to Key Value: logins now survive restarts.`
   Everyone logs in once more after this restart, and from then on deploys
   keep them logged in.

Good to know about the free Key Value:

- It holds 25 MB and keeps everything in memory, without saving to disk. If
  Render restarts the Key Value instance itself (rare, e.g. maintenance),
  people log in once more. Nothing else is lost: parts and files live in
  LUNA Parts and Onshape, never in Key Value.
- Logins stay for a day after the panel was last used.
- Only logins move to Key Value. The server's caches of Onshape data stay in
  its memory, so a deploy still costs a few extra Onshape calls afterwards.
- To go back to memory logins, delete `REDIS_URL` from **Environment**.
- If the log shows `Key Value (session store) error` lines, check that the
  Key Value instance is **Available** and in the same region, and that
  `REDIS_URL` is the internal address.

## Deploys

- Every merge into `master` starts a deploy. Watch it under **Events** or
  **Logs**. "Your service is live" means it's done.
- A deploy restarts the server. Its memory is wiped, so the caches start
  empty and the next few panel actions use a few more Onshape calls. Without
  Key Value (step 4) everyone is also logged out and has to reopen the panel. Merging
  several pull requests together, instead of one at a time, saves calls.
- If a deploy breaks something, open **Events**, find the last good deploy,
  and click **Rollback** (or revert the pull request on GitHub).

## Reading the logs

Click **Logs** on the service. Useful lines:

- `Luna Parts Bridge listening on port ...`: the server started.
- `Connected to Key Value: ...` or `REDIS_URL is not set ...`: where logins
  are kept.
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
- Key Value: https://render.com/docs/key-value
