# Onshape setup

This is everything on the Onshape side: the OAuth app that lets the server act
for each student, the two panel buttons (extensions), and the private App Store
entry that puts the panel in front of the team.

Do the [Render setup](render-setup.md) first, so you already know the server's
address. Below it is written as `https://onshape-lunaparts-coallition.onrender.com`.
If yours is different, use yours everywhere.

## Where the app lives

Onshape counts API calls against whoever owns the app. Free and education
accounts get about 2,500 calls a year each. The **LUNATECS Team 316**
classroom has its own, bigger allowance (12,500 a year, resetting every
December 15), so the app is registered under the classroom, not under one
person's account.

You need to be an admin of the classroom to change these settings.

## 1. Create the OAuth app

1. In Onshape, click your profile icon (top right) and choose **Classroom
   settings** (it may say Company/Classroom settings).
2. On the left, click **Developer**, then **OAuth applications**, then
   **Create new OAuth application**.
3. Fill in the form:
   - **Name:** `Luna Parts Bridge`
   - **Primary format:** something unique, like `org.lunatecs.lunapartsbridge`
   - **Summary:** `Sends parts and files from Onshape to Team 316's LUNA Parts tracker.`
   - **Redirect URLs:** `https://onshape-lunaparts-coallition.onrender.com/oauth/callback`
   - **OAuth URL:** `https://onshape-lunaparts-coallition.onrender.com/oauth/login`
   - **Permissions:** tick all three of these:
     - **Read your profile information** (the "Uploaded by" note in LUNA Parts)
     - **Read your documents** (parts lists, shapes, exports)
     - **Write to your documents** (renaming parts, making drawings, filling title blocks)
4. Click **Create application**.
5. Onshape shows the **Client ID** and **Client secret**. The secret is shown
   only once. Paste both straight into Render as `ONSHAPE_CLIENT_ID` and
   `ONSHAPE_CLIENT_SECRET` (see [Render setup](render-setup.md#2-add-the-environment-variables)).
   Don't paste them in chat, email or Discord.

If you lose the secret, open the app's **Keys and secret** tab, make a new one,
and replace `ONSHAPE_CLIENT_SECRET` in Render.

If you add a permission later (for example "write"), everyone has to log in
again once so Onshape asks them to allow it. The panel's **Reconnect to
Onshape** link does that (it opens `/oauth/login?force=1`).

## 2. Add the two panel extensions

An extension is the button that opens the panel inside Onshape. The app needs
two: one for Part Studios and one for assemblies. They are the same apart from
the context.

1. Open the app and click the **Extensions** tab, then **Add extension**.
2. Fill in:
   - **Name:** `Luna Parts Bridge`
   - **Location:** **Element right panel**
   - **Context:** **Inside part studio**
   - **Action URL** (copy exactly, curly brackets and all):

     ```
     https://onshape-lunaparts-coallition.onrender.com/oauth/login?documentId={$documentId}&workspaceId={$workspaceId}&elementId={$elementId}
     ```

     Onshape fills in the `{$...}` parts with the open document's IDs, which
     is how the server knows which Part Studio or assembly the panel is in.
   - **Icon:** upload the team icon (`public/icon.png` in this repo works).
3. Click **Add extension** again and make the second one exactly the same, but
   with **Context: Inside assembly**.

## 3. Give the team the panel (private App Store entry)

1. In the developer settings, open **Store entries** and create an entry for
   the app.
2. Set its visibility to **Team** (private), not public. A private entry needs
   no review from Onshape.
3. Add each student who should use the panel (or the team group). People added
   there can open the panel without paying or subscribing to anything.

A public App Store listing would remove the yearly call limit, but that needs
Onshape's review and is a separate, later step.

## 4. Test it

1. Open the robot assembly in Onshape.
2. Open the right-side panel list and pick **Luna Parts Bridge**.
3. The first time, Onshape asks you to allow the app. Click **Allow**.
4. The parts list should load. If it does, Onshape is set up.

## When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "Could not read parts from Onshape (402)" or "the yearly limit on API calls ... has been used up" | The app's yearly Onshape call allowance is used up. The server then stops calling Onshape for 10 minutes. | Email api-support@onshape.com for more calls. |
| "The app can't edit Onshape yet" | The app is missing **Write to your documents**. | Tick it on the OAuth app, then click **Reconnect to Onshape** in the panel. |
| "Your Onshape login expired" | The login token ran out. | Close and reopen the panel. |
| "OAuth state mismatch" | The login was started in a different tab or took too long. | Close and reopen the panel. |
| The panel says to open it from inside Onshape | It was opened straight from the Render address. | Open it from the extension inside a document. |

The server's log on Render prints a line like
`[onshape calls] GET /api/onshape/parts: 2 (130 since the server started)`
for every panel action, so you can see where the calls go. The panel's Sync log
adds them up too.

## Reference

- Onshape developer portal: https://dev-portal.onshape.com
- OAuth apps: https://onshape-public.github.io/docs/auth/oauth/
- Extensions (Action URLs and contexts): https://onshape-public.github.io/docs/app-dev/extensions/
- API call limits: https://onshape-public.github.io/docs/auth/limits
- Classroom developer settings: https://cad.onshape.com/help/Content/Plans/enterprise_settings_developer.htm
