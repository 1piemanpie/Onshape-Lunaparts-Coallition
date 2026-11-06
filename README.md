# Luna Parts Bridge

An Onshape side panel for FRC Team 316 LUNATECS. Students open it from a Part
Studio or an assembly, tick the parts they want to send, and the panel creates
them in [LUNA Parts](https://build.lunatecs.org) (the team's part tracker) with
their drawing PDF, DXF and STEP files attached. It can also number parts,
spot copies and mirror twins, and make the team's standard drawings.

```
Onshape (panel in an iframe)  ──>  this server on Render  ──>  Onshape REST API
                                          │
                                          └──────────────>  LUNA Parts API
```

The browser never sees any secret. The Onshape app secret and the LUNA Parts
API key live only in Render's environment variables, and only this server
uses them.

## Setting it up

Follow these in order. Each guide is step by step.

1. [Render setup](docs/render-setup.md): the web server that runs the app, its
   settings and its environment variables.
2. [Onshape setup](docs/onshape-setup.md): the OAuth app, the two panel
   extensions, and the private App Store entry that gives the team the panel.

Useful links:

- Render dashboard: https://dashboard.render.com
- Render docs for Node web services: https://render.com/docs/deploy-node-express-app
- Onshape developer portal: https://dev-portal.onshape.com
- Onshape API docs: https://onshape-public.github.io/docs/
- Onshape API call limits: https://onshape-public.github.io/docs/auth/limits
- LUNA Parts: https://build.lunatecs.org (API base `https://build.lunatecs.org/api/v1`)

## Environment variables

Set these in Render (Service > Environment). Never put real values in the
code, in `.env.example`, or in chat.

| Name | Needed? | What it is |
|---|---|---|
| `ONSHAPE_CLIENT_ID` | yes | The OAuth app's Client ID, from Onshape |
| `ONSHAPE_CLIENT_SECRET` | yes | The OAuth app's Client secret, from Onshape |
| `SESSION_SECRET` | yes | A long random string that signs the login cookie |
| `LUNA_PARTS_API_KEY` | yes | A LUNA Parts API token whose user is an editor |
| `LUNA_PARTS_API_BASE` | no | Defaults to `https://build.lunatecs.org/api/v1` |
| `ONSHAPE_API_BASE` | no | Defaults to `https://cad.onshape.com/api` |
| `PORT` | no | Render sets this itself |

## Files

| File | What it does |
|---|---|
| `server.js` | Starts the Express server and wires the pieces below together |
| `routes/auth.js` | Logging in with Onshape (OAuth) and `/api/session` |
| `routes/onshape.js` | The panel's Onshape routes: parts list, clicks, shapes, pictures, twins, numbering, drawings |
| `routes/luna.js` | The panel's LUNA Parts routes: dropdown lists, creating parts, renumbering, uploading files |
| `lib/middleware.js` | Checks shared by the routes: logged in, opened inside Onshape, LUNA key set, `validate()` |
| `lib/schemas.js` | What each route accepts, as [zod](https://zod.dev) schemas, with the panel's error messages |
| `lib/luna.js` | Calling the LUNA Parts API (key, paging, statuses) |
| `lib/onshape/api.js` | Calling the Onshape API, counting calls, pausing after a 402 |
| `lib/onshape/cache.js` | Caching Onshape answers by document version |
| `lib/onshape/parts.js` | Parts: groups, block CAD, assemblies, sizes, mass properties |
| `lib/onshape/title-block.js` | Filling a drawing's title block |
| `lib/onshape/exports.js` | DXF, STEP and drawing PDF files |
| `lib/drawings.js` | Makes the team's Onshape drawings |
| `lib/detect.js` | Works out what a part is (plate, pocketed plate, box tube, shaft) |
| `lib/dxf.js` | Builds DXF files from a part's flat face |
| `lib/twins.js` | Tells copies of a part from mirror images |
| `public/index.html` | The panel itself (HTML, CSS and JavaScript in one file) |
| `package.json`, `package-lock.json` | The packages the server needs, at exact versions |
| `test/` | `npm test`: replays ~150 requests against fake Onshape and LUNA Parts and checks nothing changed |

## Running it on your own computer (optional)

Only needed if you want to change the code and try it before pushing. You need
[Node.js](https://nodejs.org) 20 or newer (the LTS download is fine).

1. Copy `.env.example` to `.env` and fill it in (the `.env` file is ignored by
   git, so it is never committed).
2. Run `npm ci` to install the exact package versions from `package-lock.json`.
3. Run `node --env-file=.env server.js` and open http://localhost:3000.

Onshape only opens the panel from the Render address, so most testing still
happens on Render after a merge to `master`.

`npm test` needs no keys and calls nothing real: it starts the server with
fake Onshape and LUNA Parts answers, sends it every kind of request, and
compares the answers (and every call the server tried to make) with the saved
ones in `test/expected/`. If a change is meant to alter behaviour, check the
differences it prints, then run `npm test -- --update` to save the new ones.

## Deploying

Render watches the `master` branch. Merging a pull request into `master`
deploys it automatically in a few minutes. See
[Render setup](docs/render-setup.md#deploys) for what happens during a deploy.
