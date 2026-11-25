# Code guide: Luna Parts Bridge

A map of the whole codebase for a reviewer (person or AI) who has never seen it.
Read this first, then the code. It is current through PR #89 (2026-11-25).

The owner, Micah, is a high school student on FRC Team 316 LUNATECS and is new
to web development. Most of the code was written with an AI assistant, one pull
request at a time, and tested by Micah on the real Onshape and LUNA Parts after
each merge. That history matters: see [Known weak spots](#9-known-weak-spots-and-untested-areas).

---

## 1. What the app does

Luna Parts Bridge is an **Onshape side panel**. Students open it on the right
side of Onshape while looking at a robot subsystem assembly. It takes the parts
the team designed and creates them in **LUNA Parts** (https://build.lunatecs.org),
the team's own part tracker, with the files the shop needs attached: a drawing
PDF, a DXF for CNC parts, and optionally a STEP. Nobody has to export files or
type parts into LUNA by hand.

Along the way it can also:

- **Number parts** in Onshape in the team's format (`26O-E018`).
- **Find copies and mirror twins** so one real part becomes one LUNA part with
  the right quantity.
- **Make real Onshape drawings** in the team's layout (views, dimensions, hole
  callouts, notes, title block), which students open and fix in Onshape before
  they go to the shop.
- **Work out what a part is** (plate, pocketed plate, box tube, shaft) and guess
  the machine, thickness, cut length and which DXFs it needs.
- **Update files** of parts already in LUNA, and show parts in LUNA that are
  missing a drawing or a DXF.

```
Onshape (panel in an iframe)  ──>  this server on Render  ──>  Onshape REST API
        public/index.html             server.js                (each student's OAuth token)
                                          │
                                          └──────────────>  LUNA Parts REST API
                                                            (one shared team key)
```

The browser never sees a secret. The Onshape client secret and the LUNA API key
live only in Render's environment variables.

## 2. Stack and hosting

- **Node 18+ / Express 4**, `express-session`, `zod` for input checks,
  `connect-redis` + `redis` for sessions. No database. No build step. No
  front-end framework.
- **Front end:** `public/index.html`, one file of HTML, CSS and plain JavaScript
  (~4,000 lines, ~140 functions).
- **Hosting:** Render free tier, auto-deploys from `master`. A free UptimeRobot
  ping every 5 minutes keeps it awake. Every deploy restarts the server, which
  **wipes every in-memory cache** (and, unless `REDIS_URL` is set, every login).
- **Sessions:** in Render Key Value (Redis) when `REDIS_URL` is set, otherwise
  memory. The cookie is `SameSite=None; Secure` because the panel is a
  third-party iframe inside Onshape.
- **Env vars:** `ONSHAPE_CLIENT_ID`, `ONSHAPE_CLIENT_SECRET`, `SESSION_SECRET`,
  `LUNA_PARTS_API_KEY`, optional `LUNA_PARTS_API_BASE`, `ONSHAPE_API_BASE`,
  `REDIS_URL`, `PORT`. See `README.md` and `.env.example`.

## 3. Files, and what each one does

| File | Lines | What it does |
|---|---|---|
| `server.js` | 64 | Wires everything: session, static files, `/health`, call counting, the three routers. |
| `routes/auth.js` | 109 | Onshape OAuth 2 login (`/oauth/login`, `/oauth/callback`) and `/api/session`. Stores the open document's IDs in the session. |
| `routes/onshape.js` | 607 | Onshape routes: parts list, 3D click lookup, part shape and picture, twins, next number, rename, drawing list, **make-drawing**, renumber-drawing, `/api/usage`. |
| `routes/luna.js` | 544 | LUNA routes: dropdown options, part numbers already used (plus linked-part matching and duplicates), part files, drawing check, DXF check, renumber in LUNA, assemblies, statuses, **create part**, **attachments** (builds/export files and uploads them). |
| `lib/middleware.js` | 48 | `requireLogin`, `requirePanel` (sets `req.dwe`), `requireLunaKey`, `validate(source, schema)`. |
| `lib/schemas.js` | 249 | zod schemas for every route's input, with the panel's error messages. |
| `lib/session-store.js` | 35 | Redis session store when `REDIS_URL` is set. |
| `lib/luna.js` | 331 | LUNA API client: paging, `/options` (with fallback), a synced copy of every LUNA part (`updated_since`), drawing status per part. |
| `lib/onshape/api.js` | 95 | `onshapeFetch()`: the **only** way the server calls Onshape. Adds the token, counts the call, pauses 10 min after a 402. |
| `lib/onshape/cache.js` | 253 | Caching by document microversion, verified-doc sharing between sessions, parts list, `bodydetails`, element (tab) list, element type. |
| `lib/onshape/parts.js` | 389 | Assembly parts (instances → source Part Studios, quantities, sub-assemblies), groups (team / stock / block CAD / hardware), linked-part keys, bounding box, part shape, mass properties, FeatureScript helpers, the user's name. |
| `lib/onshape/title-block.js` | 128 | Writes part properties (Part number, Title 1, Description) and the drawing tab's own Part number / Title 1 / name. |
| `lib/onshape/exports.js` | 102 | DXF (built locally), STEP and drawing PDF (Onshape translations, polled). |
| `lib/drawings.js` | 1288 | Plans and makes an Onshape drawing: part analysis, view layout per part type, annotations (dims, hole callouts, ream/tap notes, hex shaft rules), overlap check, Onshape drawing create/modify calls, empty-drawing cleanup. |
| `lib/detect.js` | 429 | From `bodydetails` only: plate vs pocketed plate vs box tube vs shaft, saw cut length, tube sides with holes. |
| `lib/dxf.js` | 222 | Builds a DXF from a flat face (outline, holes, pocket layers, ream undersize). |
| `lib/twins.js` | 224 | Point matching to tell a copy from a true mirror image (or "too symmetric to tell"). |
| `lib/square-up.js` | 167 | For parts modelled at an angle: works out the rotation and makes a helper assembly tab with the part turned square, so the drawing views line up. |
| `public/index.html` | 3984 | The whole panel UI. Sections are marked with `// ---- Name ----` comments (Parts checklist, Part namer, Twins, Saved progress, Stepping through the ticked parts, Saved parts, The drawing check, Upload, Update files, Check updates, Parts in LUNA with no drawing, Find missing DXFs, ...). |
| `test/` | | `npm test`, see [section 8](#8-tests). |
| `docs/render-setup.md`, `docs/onshape-setup.md` | | Step-by-step setup guides. |

## 4. Main user flows

Everything is normally done from the panel opened in the **subsystem assembly**.

1. **Open the panel.** Onshape loads `/oauth/login?documentId&workspaceId&elementId`
   in the iframe. The session remembers those IDs (`req.session.onshapeContext`).
   The panel calls `/api/onshape/parts`, `/api/luna/options`, `/api/luna/part-numbers`
   and `/api/luna/drawing-check`.
2. **Parts list.** Every part with its quantity (copies across sub-assemblies).
   Team-numbered parts on top; folds for ALREADY IN LUNA PARTS, BLOCK CAD
   (DERIVED), HARDWARE & COTS. Material under each row. Linked parts get a
   LINKED tag. Ticks are saved in `localStorage` (`lunaProgress:<doc>:<elem>`).
3. **NAME.** Renames parts in Onshape to the next number (`/api/onshape/next-number`
   counts both Onshape names and the LUNA project, then `/api/onshape/rename`,
   one metadata POST each). UNDO puts the last name back. Twins share a number.
   Linked parts can't be renamed, so they get a LUNA-only number.
4. **CREATE PARTS → one card per part.** Project, name, part number (warns if it
   doesn't match the team format or project prefix), status, machine (guessed),
   material, thickness (snapped to stock), type, quantity, cut length, parent
   assembly, drawing, STEP. The card shows a picture of the part
   (`/api/onshape/part-image`), because an app **cannot highlight a part inside
   an assembly**, so the picture is the only way to know which part it is.
5. **SAVE & NEXT.** Saves the card in `localStorage` (`lunaStaged:<doc>:<elem>`)
   and starts `/api/onshape/make-drawing` in the background.
6. **Check drawings.** Each saved part with its drawing: OPEN, OK tick, EDIT,
   REMOVE, RETRY on a failed drawing.
7. **UPLOAD ALL.** For each OK'd part: `POST /api/luna/parts`, then
   `POST /api/luna/parts/:id/attachments` (PDF with `is_drawing=1` in one
   request, DXF/STEP in another). Two parts at a time.
8. **Done screen.** SENT / SKIPPED / FAILED, plus a DESIGN PACK link per project.

Later flows for parts already in LUNA: **UPDATE FILES / UPDATE ALL** (re-send
files as the next attachment revision, after a Check updates screen with OK
ticks), **RENUMBER** (fix a wrong number in LUNA and on the drawing tab, via
`PUT /parts/{id}`), **LINK TO IT** (attach a linked part to an existing LUNA
part), **ADD / ADD ALL** in the red "missing drawings" box, **FIND MISSING DXFs**,
and **COTS / NOT COTS** on any row.

## 5. Team rules the code enforces (must keep)

These came from the team's manufacturing manual and Micah's decisions. A review
should not suggest removing or weakening any of them.

- **Part numbers:** `26O-E001` = year `26` + `O` (offseason robot) + `-` +
  subsystem letter `E` + 3-digit number. Same prefix carries on from the highest
  number; if most ticked parts use a different/old name type, all ticked parts
  are renumbered from 001. The Onshape part name **is** the part number. Numbers
  are never reused (Onshape names and LUNA are both counted).
- **One LUNA part per real part.** Copies add to quantity; true left/right
  mirrors get their own numbers; parts too symmetric to check get a SAME PART
  button.
- **Linked FRC Design App parts** (hex shafts, spacers from another document at
  a saved version) can't be renamed by an app. Each gets **exactly one** LUNA
  number, tied to it by LUNA's `external_ref` = `onshape:<key>` (older parts
  have an `[onshape:<key>]` tag in their notes instead). The key comes from
  `linkedPartKey()` and deliberately drops the version, so one spacer is one row
  across versions. Creating a linked part that is already in LUNA returns 409
  with `alreadyIn`. Name matching is only a fallback, and only inside the
  panel's own project (each subsystem project numbers the same spacer on its own).
- **DXF rule:** a DXF is attached only when the Machine name contains CNC, mill
  or router, never lathe (`isCncTool`). A CNC part **always** needs a DXF: a
  failed DXF shows red with ADD DXF (`dxfMissing`).
- **Pocketed plates:** DXF drawn from the flat back side, layer `THROUGH`
  (outline and through holes) and `POCKET_<depth>IN` per depth.
- **Box tube:** pre-drilled only if the 0.196" hole pattern on 0.5" spacing runs
  the **full** length (saw only, no DXF). Otherwise every hole is milled and
  there is one DXF per side with holes.
- **Ream:** bearing holes 1.125" and 0.875" are cut 0.010" undersize in the DXF
  and say Ream on the drawing.
- **Saw cut:** under 12" the exact length; 12" or more round up to the next
  1/16" and face down. (The "Cut to ... on bandsaw" note was removed from
  drawings in #88; the LUNA Cut Length field stays.)
- **Drawings are real Onshape drawing tabs**, named `<part number> Drawing <n>`,
  ANSI A, inches, third angle, LUNATECS title block. Students must be able to
  open and fix them in Onshape, so making PDFs on our server instead is not
  acceptable. The part number and name go **in the title block**, not the notes.
  Drawing tabs are matched to parts by the first word of the tab name, which must
  look like a real part number (`looksLikePartNumber`); catalog names like
  "Shaft" once gave one part another part's drawing (#86).
- **Empty drawings are not kept:** if adding views fails, the new tab is deleted
  and the card shows RETRY (#66).
- **Hardware/COTS** (screws, bearings, library parts, hex shafts and hex-bore
  spacers, hand-marked COTS) go in a closed fold and are never uploaded.
- **"Uploaded by <Onshape name>"** goes in LUNA notes, because every upload uses
  the one shared team key.
- **Each student signs in with their own Onshape account.** The panel only sees
  what that student can open.
- **Never highlight parts in an assembly** (`requestSelectionHighlight` froze
  Onshape in PR #20). Highlight messages only accept ENTITY, BODY or GEOMETRY.
- **Style:** Team 316 colours only (black, white, yellow `#ccff00` only on black).

## 6. Onshape API call budget (the biggest constraint)

- The OAuth app is owned by the "LUNATECS Team 316" Onshape **classroom**, which
  has **12,500 API calls a year** for everyone together, resetting **December 15**.
  Onshape counts calls against the app's owner, so spreading them across
  students' logins doesn't help. When it runs out, every call returns **402** and
  the panel stops for the whole team (this already happened once on Micah's
  personal account).
- A public Onshape App Store listing would remove the limit. That's the long-term
  plan, so nothing should block a public listing later.
- **Rules in the code:** every call goes through `onshapeFetch()` and is counted
  (`X-Onshape-Calls` header per request, Render log lines, `GET /api/usage`).
  Everything is cached by **document microversion** (one cheap
  `currentmicroversion` check, trusted for 20 s). Parts from another document at
  a saved version are cached forever. No prefetching per part, no polling
  Onshape on a timer, no hover pictures. After a 402 the server stops calling
  Onshape for 10 minutes.
- **Rough costs:** panel open warm 0 to 1 call, cold assembly ~13+; rename 1 per
  part; card picture 1 (cached 12 h); new drawing ~11 to 15; PDF/STEP export 3
  to 5 each (start, poll, download); DXF 0 (plus 1 for curves). A 30-part
  subsystem is roughly 650 to 750 calls, about 70% of it drawings.
- Calls to LUNA Parts are free and don't count.
- A detailed per-action breakdown and a list of ideas already ruled out is in
  the team's earlier brief (Nov 3, through PR #59); the same numbers are above.
  Ideas **already ruled out**: running geometry in FeatureScript (it is an API
  call too), Onshape-side webhooks for translations (small win, extra moving
  parts), server-made PDFs instead of Onshape drawings, retrying smaller drawing
  scales, prefetching pictures, a hover 3D viewer, dropping the card picture,
  polling for changes.

## 7. LUNA Parts API constraints

- Base `https://build.lunatecs.org/api/v1`, `Authorization: Bearer <key>`, one
  shared team key with **editor** rights, kept server-side only.
- **We don't control LUNA's backend.** A teammate (Noah) runs it. We can only use
  the REST API it has. The docs and OpenAPI spec are behind a LUNA login, so the
  spec is not in this repo; everything the app uses is visible in `lib/luna.js`
  and `routes/luna.js`.
- **No test server.** Every write goes to the team's real tracker. Testing uses
  a throwaway project.
- Endpoints used: `GET /options`, `GET /parts` (paged, `per_page` max 100,
  `updated_since` sync with `deleted_ids`, filters such as `external_ref`),
  `GET /parts/{id}`, `POST /parts` (multipart), `PUT /parts/{id}` (JSON; needs
  name, part_number, part_status_id, type, quantity sent back), `GET/POST
  /parts/{id}/attachments` (multipart, `files[]`, `revision`, `is_drawing`).
- **No PATCH** in the spec, so edits read the part and send the required fields
  back with `PUT`.
- **No 409 for duplicates** on LUNA's side, so the bridge checks for duplicate
  numbers and linked keys itself before creating.
- Deleting a part in LUNA frees its number (by suffixing it) and clears
  `external_ref`.
- The server keeps a synced copy of every LUNA part (`getParts()`, delta sync,
  full refresh every 6 h) and answers most lookups from it.

## 8. Tests

```
npm ci
npm test            # check nothing changed
npm run test:update # save new expected output, only after checking the diff is intended
```

- `test/api.test.js` starts the real server with `fetch` replaced by fakes
  (`test/fake-apis.js`), sends ~150 requests from `test/requests.js` (every
  route: logged out, Part Studio, assembly, bad input), and compares every answer
  **and every outgoing Onshape/LUNA call** against `test/expected/responses.jsonl`
  and `test/expected/calls.log`. A change in `calls.log` is a change in how many
  Onshape calls something costs, so read it carefully.
- `test/drawings.test.js`, `square-up.test.js`, `luna-sync.test.js`,
  `luna-drawings.test.js` are unit tests for those pieces.
- No keys needed and nothing real is called. `TEST_REDIS_URL=redis://...` runs
  the same with a real Redis.
- **Limits of the tests:** the fakes were written from the API docs, not from real
  responses, for most endpoints. Passing tests do not prove the code works on the
  real Onshape or LUNA.

## 9. Known weak spots and untested areas

Be honest about these; they are the most useful places to look.

**Never checked against the real Onshape or LUNA** (merged and passing tests,
but response shapes or behaviour are guessed):

- Auto-detect and DXFs for pocketed plates and box tube sides (#56-#58).
- Empty-drawing cleanup and the 180 s views wait (#66); drawing tab's own
  Title 1 for linked parts (#68); DWG NO box from the drawing's Part number (#52).
- Squared helper assembly for angled parts (#76, #77). The first real test made
  the helper tab but **did not turn the part**; a fix for an empty reply body went
  in and is waiting for a retest.
- Linked-part numbering, RENUMBER, LINK TO IT, duplicate cleanup (#78-#82, #87,
  #89). One linked hex shaft wasn't matched to its LUNA part by key or name and
  the cause is still unknown.
- Missing-drawings box and drawing check (#84); Check updates screen (#86);
  CNC-means-DXF everywhere (#75).
- `currentmicroversion` response shape (falls back to 30 s per-session caching
  after 3 failures).

**Known open issues:**

- A linked part's drawing title block shows the catalog part's own properties
  ("Shaft", "11") instead of the bridge's name, because linked parts can't be
  edited. Not solved yet.
- **No Onshape token refresh.** The refresh token is stored but never used; when
  the access token expires the student has to reopen the panel.
- **Access control:** any Onshape user who completes the OAuth login gets a
  session, and the `/api/luna/*` routes only check `requireLogin`. So, in
  principle, someone outside the team who finds the server URL could read the
  team's LUNA parts and create parts with the team key. The app is only in a
  private App Store entry, and a team-only allowlist (#43) was closed on purpose,
  but this deserves a careful look.
- In-memory state (caches, `drawingsInFlight`, `drawingsMadeHere`, the cached
  Name property ID, the 402 pause) is lost on every deploy and is shared by all
  users of the one server process.
- `public/index.html` is one ~4,000-line file with lots of `localStorage` state
  (`lunaProgress:`, `lunaStaged:`, `lunaCots:`, `lunaTwins:`, `lunaProject:`,
  `lunaPrefix:`, ...). Stale saved state after code changes is a likely source of
  odd bugs.
- Geometry code (`drawings.js`, `detect.js`, `dxf.js`, `twins.js`,
  `square-up.js`) relies on tolerances and on real `bodydetails` using lowercase
  geometry types ("plane", "line", "circle") even though the API spec shows caps.

## 10. What kind of review is wanted

1. **Report first. Don't change code yet.** Give a ranked list, most serious
   first. For each finding: file and function (with line numbers), what goes
   wrong and when (a concrete example), how sure you are, and a suggested fix.
2. **Priorities:** (a) bugs that could put wrong data into LUNA (wrong number,
   duplicate part, wrong drawing on a part, missing DXF on a CNC part);
   (b) security and secrets (the LUNA key, sessions, access control, input
   checks, anything that could leak or be abused); (c) things that waste Onshape
   API calls; (d) crashes and unhandled errors; (e) code that's hard to maintain,
   only where it is likely to cause bugs.
3. **Respect the must-keep list** in section 5 and the ruled-out list in
   section 6. If you think one of them is wrong, say why, but don't count it as a
   bug.
4. **Count Onshape calls** for any idea that changes them (per action and roughly
   per 30-part subsystem). LUNA calls are free.
5. **Say what you could not check.** You can't reach Onshape or LUNA, so mark
   anything that depends on a real API response shape as unverified.
6. **Keep it simple.** The owner is new to web dev. Small, safe fixes beat big
   rewrites. Explain findings in plain English.
7. If you later make changes: **one fix per pull request**, against `master`
   (never stack pull requests on each other), with `npm test` passing and any
   `test/expected/` changes explained.
