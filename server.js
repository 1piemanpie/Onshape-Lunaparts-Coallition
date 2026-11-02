const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { faceToDxf, edgesNeedingPoints, isPlanar, pickFace, REAM_UNDERSIZE_IN } = require('./dxf');
const { compareBodies } = require('./twins');
const { makeDrawing } = require('./drawings');

const app = express();
const PORT = process.env.PORT || 3000;

const ONSHAPE_AUTHORIZE_URL = 'https://oauth.onshape.com/oauth/authorize';
const ONSHAPE_TOKEN_URL = 'https://oauth.onshape.com/oauth/token';

// Render sits behind a proxy that terminates HTTPS, so Express needs this
// to know the original request was secure (required for secure cookies
// and for req.protocol to correctly report "https" below).
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // The panel loads inside an iframe on Onshape's domain, which makes
    // this a third-party cookie from the browser's point of view —
    // SameSite=None + Secure is required or browsers will silently drop it.
    sameSite: 'none',
    secure: true,
  },
}));

// Serves everything in /public — right now that's just the panel UI
// (public/index.html). Onshape will point at this server's URL and load
// that page inside an iframe in the sidebar.
app.use(express.static(path.join(__dirname, 'public')));

// Render (and Onshape, when checking your app is alive) can hit this to
// confirm the server is up.
app.get('/health', (req, res) => res.send('ok'));

function callbackUrl(req) {
  return `${req.protocol}://${req.get('host')}/oauth/callback`;
}

// Step 1: this is the "OAuth URL" registered with Onshape. Onshape fetches
// it to start login — we send the browser on to Onshape's own authorize
// screen, with a random `state` value we can verify on the way back.
//
// The Onshape extension's Action URL points here too, with the open
// document's IDs filled in by Onshape. We keep those in the session so the
// panel knows which Part Studio it's sitting in once login finishes.
const ONSHAPE_ID = /^[0-9a-f]{24}$/;

app.get('/oauth/login', (req, res) => {
  const { documentId, workspaceId, elementId } = req.query;
  if ([documentId, workspaceId, elementId].every((id) => ONSHAPE_ID.test(id || ''))) {
    req.session.onshapeContext = { documentId, workspaceId, elementId };
  }

  // Already logged in with a token that hasn't expired: skip straight to the panel.
  // ?force=1 logs in again, e.g. after the app was given edit permission.
  const tokens = req.session.onshapeTokens;
  if (tokens && tokens.expiresAt > Date.now() && req.query.force !== '1') {
    return res.redirect('/');
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: process.env.ONSHAPE_CLIENT_ID,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    state,
  });

  res.redirect(`${ONSHAPE_AUTHORIZE_URL}?${params.toString()}`);
});

// Step 2: Onshape redirects back here (the registered "Redirect URL") with
// a one-time code. We exchange it, server-side, for an access token —
// this is the one request that needs the client secret, which is why it
// can't happen in the browser.
app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('OAuth state mismatch — please try connecting again.');
  }
  delete req.session.oauthState;

  if (!code) {
    return res.status(400).send('Onshape did not return an authorization code.');
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.ONSHAPE_CLIENT_ID,
      client_secret: process.env.ONSHAPE_CLIENT_SECRET,
      redirect_uri: callbackUrl(req),
    });

    const tokenRes = await fetch(ONSHAPE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      console.error('Onshape token exchange failed:', tokenRes.status, await tokenRes.text());
      return res.status(502).send('Could not complete Onshape login. Please try again.');
    }

    const tokens = await tokenRes.json();
    req.session.onshapeTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };

    res.redirect('/');
  } catch (err) {
    console.error('Onshape token exchange error:', err);
    res.status(502).send('Could not complete Onshape login. Please try again.');
  }
});

// Lets the panel's front-end check whether this session is logged in yet.
app.get('/api/session', (req, res) => {
  res.json({
    connected: Boolean(req.session.onshapeTokens),
    context: req.session.onshapeContext || null,
  });
});

// ---- Onshape REST API ---------------------------------------------------
const ONSHAPE_API_BASE = process.env.ONSHAPE_API_BASE || 'https://cad.onshape.com/api';

// ---- Counting Onshape calls ----------------------------------------------
// Onshape caps how many API calls the app gets a year, so every call is
// counted: per panel action (sent back in the X-Onshape-Calls header, which
// the panel adds up in its Sync log), and in total since the server started
// (the Render log prints a line for every action that used any).
const usage = { since: new Date().toISOString(), total: 0, byAction: {} };
function actionName(req) {
  return `${req.method} ${req.route ? req.route.path : req.path}`;
}
app.use('/api', (req, res, next) => {
  req.onshapeCalls = 0;
  const send = res.send.bind(res);
  res.send = (body) => {
    if (!res.headersSent) {
      res.set('X-Onshape-Calls', String(req.onshapeCalls));
      res.set('X-Onshape-Calls-Total', String(usage.total));
    }
    return send(body);
  };
  res.on('finish', () => {
    if (req.onshapeCalls) console.log(`[onshape calls] ${actionName(req)}: ${req.onshapeCalls} (${usage.total} since the server started)`);
  });
  next();
});

// After a 402 (yearly limit used up) the server stops calling Onshape for a
// while, so a panel left open can't keep hammering it.
const LIMIT_PAUSE_MS = 10 * 60 * 1000;
let limitHitAt = 0;

// { raw: true } returns the file bytes (a Buffer) instead of parsed JSON.
async function onshapeFetch(req, path, { raw = false, ...options } = {}) {
  if (Date.now() - limitHitAt < LIMIT_PAUSE_MS) {
    const err = new Error(`Onshape ${path} skipped: the yearly API limit was hit recently.`);
    err.status = 402;
    throw err;
  }
  req.onshapeCalls = (req.onshapeCalls || 0) + 1;
  usage.total += 1;
  const action = actionName(req);
  usage.byAction[action] = (usage.byAction[action] || 0) + 1;
  const res = await fetch(`${ONSHAPE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${req.session.onshapeTokens.accessToken}`,
      Accept: raw ? 'application/octet-stream' : 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    if (res.status === 402) limitHitAt = Date.now();
    const err = new Error(`Onshape ${path} returned ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

// How many Onshape calls the server has made since it last started.
app.get('/api/usage', (req, res) => {
  if (!req.session.onshapeTokens) return res.status(401).json({ error: 'Log in with Onshape first.' });
  const byAction = Object.entries(usage.byAction).sort((a, b) => b[1] - a[1]);
  res.json({ since: usage.since, total: usage.total, byAction: Object.fromEntries(byAction) });
});

// ---- Caching by document version -----------------------------------------
// Every change to an Onshape document (in any tab) gives it a new
// "microversion". One cheap call asks for the current one; if it hasn't
// changed, everything read from the document before is still right, so it's
// reused instead of asked for again: across panel opens, tab switches,
// Refresh, and everyone on the team. Parts linked in from another document
// at a version or microversion can never change, so they're kept for good.
//
// Within DOC_CHECK_MS of the last check the answer is trusted without asking
// again, so one panel load (parts, drawings, twins) costs one check.
const DOC_CHECK_MS = 20 * 1000;
// "Check now" (Refresh, just before the cards, a click on a part not seen
// before) still trusts a check from the last few seconds, so requests sent
// together share one.
const FRESH_MS = 3000;
// Sessions that Onshape has confirmed can open each document.
const verifiedSessions = new Map(); // session ID -> Set of "doc/workspace"
const docVersions = new Map(); // "doc/workspace" -> { mv, at }
const docChecks = new Map(); // in-flight checks, per session and document
let microversionMisses = 0; // if the check itself keeps failing, stop using it
let microversionUnsupported = false;

function docKeyOf(ctx) { return `${ctx.documentId}/${ctx.workspaceId}`; }

// A stand-in when the version can't be read: the old behaviour (this session
// only, for 30 seconds).
function timeStamp(req) { return `t${Math.floor(Date.now() / 30000)}|${req.sessionID}`; }

async function docVersion(req, { maxAgeMs = DOC_CHECK_MS } = {}) {
  const ctx = req.session.onshapeContext;
  if (microversionUnsupported) return timeStamp(req);
  const docKey = docKeyOf(ctx);
  // A session only shares the team's cache once Onshape has said (with its
  // own login) that it can open this document.
  const verified = isVerified(req, docKey);
  const known = docVersions.get(docKey);
  if (known && verified && Date.now() - known.at <= maxAgeMs) return known.mv;

  const flightKey = `${req.sessionID}|${docKey}`;
  if (!docChecks.has(flightKey)) {
    const check = onshapeFetch(req, `/documents/d/${ctx.documentId}/w/${ctx.workspaceId}/currentmicroversion`)
      .then((body) => {
        const mv = String((body && (body.microversion || body.microversionId)) || '');
        if (!mv) throw new Error('Onshape sent no microversion.');
        docVersions.set(docKey, { mv, at: Date.now() });
        if (docVersions.size > 500) docVersions.clear();
        microversionMisses = 0;
        return mv;
      })
      .finally(() => docChecks.delete(flightKey));
    docChecks.set(flightKey, check);
  }
  try {
    const mv = await docChecks.get(flightKey);
    if (!verifiedSessions.has(req.sessionID)) {
      if (verifiedSessions.size > 5000) verifiedSessions.clear();
      verifiedSessions.set(req.sessionID, new Set());
    }
    verifiedSessions.get(req.sessionID).add(docKey);
    return mv;
  } catch (err) {
    if ([401, 402, 403].includes(err.status)) throw err;
    console.error('Document version check failed:', err.message);
    microversionMisses += 1;
    if (microversionMisses >= 3) {
      microversionUnsupported = true;
      console.error('Version checks keep failing, so caching falls back to 30 seconds per session.');
    }
    return timeStamp(req);
  }
}

// Parts at a saved version or microversion of another document never change.
function isFrozenSource(src) { return /^d\/[^/]+\/[vm]\//.test(src.dwe); }

function isVerified(req, docKey) {
  const docs = verifiedSessions.get(req.sessionID);
  return Boolean(docs && docs.has(docKey));
}

function canReuse(req) {
  const ctx = req.session.onshapeContext;
  return Boolean(ctx && isVerified(req, docKeyOf(ctx)));
}

function sourceStamp(req, src, opts) {
  return isFrozenSource(src) ? 'frozen' : docVersion(req, opts);
}

// One cache per kind of data, each holding one entry per Part Studio (plus
// `extra`, e.g. a part ID), replaced when the document changes.
const CACHE_LIMITS = { parts: 300, bodies: 40, derived: 300, mass: 200, box: 3000 };
const sourceCaches = Object.fromEntries(Object.keys(CACHE_LIMITS).map((k) => [k, new Map()]));

// { reuse: true } answers from whatever is cached without checking the
// document version first (used for 3D clicks; a click it can't place
// checks properly).
async function cachedForSource(req, kind, source, load, { extra = '', reuse = false, maxAgeMs } = {}) {
  const src = asSource(source);
  const cache = sourceCaches[kind];
  const key = `${src.dwe}|${src.configuration || ''}|${extra}`;
  const hit = cache.get(key);
  if (hit && reuse && (hit.stamp === 'frozen' || canReuse(req))) return hit.value;
  const stamp = await sourceStamp(req, src, { maxAgeMs });
  const again = cache.get(key);
  if (again && again.stamp === stamp) return again.value;
  if (cache.size > CACHE_LIMITS[kind]) cache.clear();
  const value = load(src);
  cache.set(key, { stamp, value });
  value.catch(() => { if (cache.get(key) && cache.get(key).value === value) cache.delete(key); });
  return value;
}

// Onshape's selection messages give the ID of whatever was clicked: the
// part itself (feature tree) or a face/edge/vertex (3D view). We work out
// which part that belongs to, then return the part's name and material.
//
// bodydetails lists every part with the IDs of its faces, edges and
// vertices, so a 3D-view click can be matched directly. It's large for a
// big Part Studio (seconds to download), so it's fetched once into a
// per-session index and reused; a click it doesn't recognise (e.g. after
// the model changed) triggers one refresh. FeatureScript's qOwnerBody is a
// last-resort fallback.
const OWNER_BODY_SCRIPT = `function(context is Context, queries) {
  return transientQueriesToStrings(evaluateQuery(context, qOwnerBody(queries.id)));
}`;

// Teams start a Part Studio by Deriving the whole robot's block CAD and
// modelling real parts on top. Those derived bodies aren't parts to make, so
// the panel folds them away. Onshape's feature list says which features are
// Derived, and FeatureScript's qCreatedBy says which bodies they made.
const FEATURE_ID = /^[A-Za-z0-9_]{1,64}$/;
function derivedBodiesScript(featureIds) {
  const ids = featureIds.map((id) => `"${id}"`).join(', ');
  return `function(context is Context, queries) {
  var found = [];
  for (var id in [${ids}]) {
    found = append(found, qCreatedBy(makeId(id), EntityType.BODY));
  }
  return transientQueriesToStrings(evaluateQuery(context, qUnion(found)));
}`;
}

async function fetchDerivedPartIds(req, source) {
  const src = asSource(source);
  // FeatureScript runs on a workspace or version, not a microversion.
  if (!/^d\/[^/]+\/[wv]\//.test(src.dwe)) return new Set();
  const { features = [] } = await onshapeFetch(req, `/partstudios/${src.dwe}/features${sourceQuery(src)}`);
  const ids = features
    .filter((f) => !f.suppressed && /derived/i.test(`${f.featureType || ''}`) && FEATURE_ID.test(f.featureId || ''))
    .map((f) => f.featureId);
  if (!ids.length) return new Set();
  const evaluated = await onshapeFetch(req, `/partstudios/${src.dwe}/featurescript${sourceQuery(src)}`, {
    method: 'POST',
    body: JSON.stringify({ script: derivedBodiesScript(ids), queries: [] }),
  });
  return new Set(((evaluated.result && evaluated.result.value) || []).map((v) => v.value));
}

// Never fails: if Onshape won't say, nothing is treated as block CAD.
// Kept until the document changes.
async function derivedPartIds(req, source, opts) {
  try {
    return await cachedForSource(req, 'derived', source, (src) => fetchDerivedPartIds(req, src), opts);
  } catch (err) {
    if (err.status === 402) throw err;
    console.error('Derived feature lookup failed:', err.message);
    return new Set();
  }
}

// A derived body that has been given a team part number (e.g. a shaft
// Derived in from the FRC Design App) is a real part; anything else that
// came in through Derive is block CAD.
function withBlockCad(group, derived) {
  return derived && group !== 'team' && group !== 'hardware' ? 'block' : group;
}

// A "source" is the Part Studio a part lives in. In a Part Studio that's
// just the open tab. In an assembly each part points back at its own Part
// Studio, maybe in another document (FRC Design App imports), at a version,
// and with a configuration (e.g. a shaft's length).
function asSource(src) {
  return typeof src === 'string' ? { dwe: src, configuration: '', linkDocumentId: '' } : src;
}

function sourceQuery(src, query = new URLSearchParams()) {
  if (src.configuration) query.set('configuration', src.configuration);
  if (src.linkDocumentId) query.set('linkDocumentId', src.linkDocumentId);
  const text = query.toString();
  return text ? `?${text}` : '';
}

function sourceKey(req, src) {
  return `${req.sessionID}:${src.dwe}|${src.configuration || ''}`;
}

// The Part Studio's parts (names, materials): one call, kept until the
// document changes. Shared by the parts list, assemblies and NAME.
function getPartsList(req, source, opts) {
  return cachedForSource(req, 'parts', source,
    (src) => onshapeFetch(req, `/parts/${src.dwe}${sourceQuery(src)}`), opts);
}

// Every face, edge and vertex of every part (big): only fetched when
// something needs the shapes (3D clicks, DXFs, twins, drawings).
function getBodyDetails(req, source, opts) {
  return cachedForSource(req, 'bodies', source, async (src) => {
    const details = await onshapeFetch(req, `/partstudios/${src.dwe}/bodydetails${sourceQuery(src)}`);
    const bodiesById = new Map();
    const entityToPart = new Map();
    for (const body of details.bodies || []) {
      bodiesById.set(body.id, body);
      for (const kind of ['faces', 'edges', 'vertices']) {
        for (const entity of body[kind] || []) entityToPart.set(entity.id, body.id);
      }
    }
    return { bodiesById, entityToPart };
  }, opts);
}

// Parts plus their shapes. The face/edge geometry is used for DXFs.
async function getPartIndex(req, source, opts) {
  const [parts, bodies] = await Promise.all([getPartsList(req, source, opts), getBodyDetails(req, source, opts)]);
  return { partsById: new Map(parts.map((p) => [p.partId, p])), ...bodies };
}

// Just the parts, by ID (no shapes).
async function getPartsById(req, source, opts) {
  return new Map((await getPartsList(req, source, opts)).map((p) => [p.partId, p]));
}

// When a part isn't where it was expected, the document may have changed:
// check its version now (one call) and only re-read when it really changed.
async function getPartIndexWith(req, source, partId) {
  const index = await getPartIndex(req, source);
  if (index.bodiesById.has(partId) || isFrozenSource(asSource(source))) return index;
  return getPartIndex(req, source, { maxAgeMs: FRESH_MS });
}

function partIdFor(index, selectionId) {
  if (index.partsById.has(selectionId)) return selectionId;
  return index.entityToPart.get(selectionId) || null;
}

async function ownerViaFeatureScript(req, dwe, selectionId) {
  const evaluated = await onshapeFetch(req, `/partstudios/${dwe}/featurescript`, {
    method: 'POST',
    body: JSON.stringify({
      script: OWNER_BODY_SCRIPT,
      queries: [{ key: 'id', value: [selectionId] }],
    }),
  });
  const ids = (evaluated.result && evaluated.result.value) || [];
  return ids.map((v) => v.value)[0] || null;
}

// 402 is Onshape's yearly API call limit: apps that aren't in the Onshape
// App Store get a fixed number of calls a year, and after that every call
// is refused until Onshape adds more.
const API_LIMIT_MESSAGE = 'Onshape has refused the request (402): the yearly limit on API calls for this app has been used up. '
  + 'Ask Onshape for more at api-support@onshape.com.';
function onshapeErrorMessage(err) {
  if (err.status === 402) return API_LIMIT_MESSAGE;
  return err.status === 401
    ? 'Your Onshape login expired. Close and reopen the panel.'
    : `Could not read parts from Onshape (${err.status || 'network error'}).`;
}

function currentDwe(req) {
  const ctx = req.session.onshapeContext;
  if (!req.session.onshapeTokens || !ctx) return null;
  return `d/${ctx.documentId}/w/${ctx.workspaceId}/e/${ctx.elementId}`;
}

// Is the panel open in a Part Studio or an assembly? Read from the
// document's tab list (which the Drawing picker needs anyway), once per
// session.
async function elementType(req) {
  const ctx = req.session.onshapeContext;
  if (!ctx.elementType) {
    let here = (await getElements(req)).find((e) => e.id === ctx.elementId);
    if (!here) {
      // A brand-new tab the cached list doesn't have yet: ask about this one.
      [here] = await onshapeFetch(req,
        `/documents/d/${ctx.documentId}/w/${ctx.workspaceId}/elements?elementId=${ctx.elementId}`);
    }
    ctx.elementType = (here && here.elementType) || 'PARTSTUDIO';
  }
  return ctx.elementType;
}

// The document's tabs (for the Drawing picker and MAKE DRAWING), kept until
// the document changes.
const elementLists = new Map();
async function getElements(req, { maxAgeMs } = {}) {
  const ctx = req.session.onshapeContext;
  const stamp = await docVersion(req, { maxAgeMs });
  const key = docKeyOf(ctx);
  const hit = elementLists.get(key);
  if (hit && hit.stamp === stamp) return hit.value;
  if (elementLists.size > 300) elementLists.clear();
  const value = onshapeFetch(req, `/documents/d/${ctx.documentId}/w/${ctx.workspaceId}/elements`);
  elementLists.set(key, { stamp, value });
  value.catch(() => { if (elementLists.get(key) && elementLists.get(key).value === value) elementLists.delete(key); });
  return value;
}

// ---- Assemblies ---------------------------------------------------------
// The panel lists every part in the assembly (and its sub-assemblies),
// counted, with the team's own parts first and hardware tucked away.
const TEAM_PART_NAME = /^(\d{2}[a-z]{1,3}-[a-z]{1,4}\d{1,4}|\d{2}-[a-z]{1,4}-\d{1,4}|[a-z]{1,3}-?\d{1,4})\b/i; // 26O-E001, E05
const STOCK_NAME = /hex|shaft|spacer|thunder ?hex/i;
const HARDWARE_NAME = new RegExp([
  'bolt', 'screw', 'nut', 'nylock', 'washer', 'bearing', 'gear', 'pulley', 'belt', 'sprocket', 'chain',
  'motor', 'bushing', 'shcs', 'bhcs', 'fhcs', 'rivet', 'standoff', 'collar', 'insert', 'spring',
  'zip ?tie', 'encoder', 'falcon', 'kraken', 'neo', 'vortex', 'cim', 'servo', 'gearbox', 'wheel',
].map((w) => `\\b${w}s?\\b`).join('|') + '|#\\d+-\\d+|\\d/\\d+-\\d+', 'i');

// Hex shaft (incl. ThunderHex) and hex-bore spacers are bought, not made
// (Micah, 2026-11-02), so they fold with the hardware unless someone has
// given one a team part number.
const COTS_STOCK_NAME = /thunder ?hex|\bhex\b.*\b(shaft|spacer)s?\b|\b(shaft|spacer)s?\b.*\bhex\b|hex[ -]?bore/i;

function partGroup(name, standardContent) {
  if (HARDWARE_NAME.test(name)) return 'hardware';
  if (TEAM_PART_NAME.test(name)) return 'team';
  if (COTS_STOCK_NAME.test(name)) return 'hardware';
  if (STOCK_NAME.test(name)) return 'stock';
  return standardContent ? 'hardware' : 'other';
}

const GROUP_ORDER = { team: 0, stock: 1, other: 2, block: 3, hardware: 4 };

function instanceSource(ctx, inst) {
  let wvm;
  if (inst.documentVersion) wvm = `v/${inst.documentVersion}`;
  else if (inst.documentId === ctx.documentId) wvm = `w/${ctx.workspaceId}`;
  else wvm = `m/${inst.documentMicroversion}`;
  return {
    dwe: `d/${inst.documentId}/${wvm}/e/${inst.elementId}`,
    configuration: inst.configuration || '',
    linkDocumentId: inst.documentId === ctx.documentId ? '' : ctx.documentId,
  };
}

const assemblyLists = new Map();

// A part made in this document's own workspace (as opposed to one linked in
// from another document or a saved version).
function isLocalSource(ctx, source) {
  return source.dwe.startsWith(`d/${ctx.documentId}/w/${ctx.workspaceId}/`);
}

// Parts linked in from another document (FRC Design App shafts, spacers)
// can't be renamed, so their team number lives only in LUNA Parts. The LUNA
// part's notes carry this tag, e.g. "[onshape:<assembly doc>|<source doc>|
// <element>|<part>|<configuration>]", which is how the panel finds the number
// again. The source version is left out so a library update keeps the match.
const ONSHAPE_TAG = /\[onshape:([^\]\s]{1,400})\]/;
function linkedPartKey(ctx, source, partId) {
  const m = source.dwe.match(/^d\/([^/]+)\/[wvm]\/[^/]+\/e\/([^/]+)$/);
  if (!m) return null;
  const configuration = source.configuration === 'default' ? '' : (source.configuration || '');
  return [ctx.documentId, m[1], m[2], partId, encodeURIComponent(configuration)].join('|');
}

async function fetchAssemblyParts(req, { reuseDerived = false } = {}) {
  const ctx = req.session.onshapeContext;
  const def = await onshapeFetch(req,
    `/assemblies/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${ctx.elementId}?includeMateFeatures=false`);

  const subKey = (a) => `${a.documentId}|${a.elementId}|${a.configuration || ''}`;
  const subs = new Map((def.subAssemblies || []).map((a) => [subKey(a), a]));
  const partKey = (p) => [p.documentId, p.elementId, p.partId, p.configuration || '',
    p.documentVersion || p.documentMicroversion || ''].join('|');
  const standard = new Set((def.parts || []).filter((p) => p.standardContent).map(partKey));

  const byKey = new Map();
  // path: instance IDs from the top of the assembly down to this one, which
  // the panel uses to highlight the part's copies in the 3D view.
  const visit = (instances, depth, path = []) => {
    if (depth > 20) return;
    for (const inst of instances || []) {
      if (inst.suppressed) continue;
      if (inst.type === 'Assembly') {
        const sub = subs.get(subKey(inst));
        if (sub) visit(sub.instances, depth + 1, [...path, inst.id]);
        continue;
      }
      if (inst.type !== 'Part' || ![inst.documentId, inst.elementId].every((id) => ONSHAPE_ID.test(id || ''))) continue;
      if (!ONSHAPE_ID.test(inst.documentVersion || inst.documentMicroversion || '')) continue;
      const key = partKey(inst);
      const known = byKey.get(key);
      if (known) { known.quantity += 1; known.occurrences.push([...path, inst.id]); continue; }
      const name = String(inst.name || 'Part').replace(/\s*<\d+>$/, '');
      const standardContent = Boolean(inst.isStandardContent || standard.has(key));
      byKey.set(key, {
        id: `a${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`,
        name,
        quantity: 1,
        group: partGroup(name, standardContent),
        partId: inst.partId,
        source: instanceSource(ctx, inst),
        occurrences: [[...path, inst.id]],
      });
    }
  };
  visit(def.rootAssembly && def.rootAssembly.instances, 0);
  const parts = [...byKey.values()];

  // Materials come from each part's own Part Studio. Hardware is skipped:
  // there can be hundreds of fasteners and nobody needs their material here.
  const sources = new Map();
  for (const p of parts) {
    if (p.group === 'hardware') continue;
    const key = sourceKey(req, p.source);
    if (!sources.has(key)) sources.set(key, { source: p.source, parts: [] });
    sources.get(key).parts.push(p);
  }
  const jobs = [...sources.values()];
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      try {
        const [byId, derived] = await Promise.all([
          getPartsById(req, job.source),
          derivedPartIds(req, job.source, { reuse: reuseDerived }),
        ]);
        for (const p of job.parts) {
          const info = byId.get(p.partId);
          p.material = info && info.material ? info.material.displayName : null;
          p.group = withBlockCad(p.group, derived.has(p.partId));
        }
      } catch (err) {
        if (err.status === 402) throw err;
        console.error('Onshape material lookup failed:', err.message);
      }
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));

  parts.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]
    || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { parts, byId: new Map(parts.map((p) => [p.id, p])) };
}

// Kept until the document changes (any edit, in any tab, makes a new
// version). { reuse: true } skips the version check.
async function getAssemblyParts(req, { maxAgeMs, reuse = false, reuseDerived = false } = {}) {
  const key = currentDwe(req);
  const hit = assemblyLists.get(key);
  if (hit && reuse && canReuse(req)) return hit.value;
  const stamp = await docVersion(req, { maxAgeMs });
  const again = assemblyLists.get(key);
  if (again && again.stamp === stamp) return again.value;
  if (assemblyLists.size > 100) assemblyLists.clear();
  const value = fetchAssemblyParts(req, { reuseDerived });
  assemblyLists.set(key, { stamp, value });
  value.catch(() => { if (assemblyLists.get(key) && assemblyLists.get(key).value === value) assemblyLists.delete(key); });
  return value;
}

// Turns the panel's part ID into the Part Studio and part it came from.
async function resolvePart(req, partId) {
  const dwe = currentDwe(req);
  if (await elementType(req) !== 'ASSEMBLY') return { source: asSource(dwe), partId };
  let list = await getAssemblyParts(req, { reuse: true });
  if (!list.byId.has(partId)) list = await getAssemblyParts(req, { maxAgeMs: FRESH_MS });
  const part = list.byId.get(partId);
  if (!part) throw new Error('Couldn\'t find the part in the assembly any more. Refresh the parts list.');
  return { source: part.source, partId: part.partId };
}

// The part's overall size, to tell shafts from plates (for the Machine guess)
// and a plate's thickness (for the Thickness guess).
const METERS_PER_INCH = 0.0254;
// Pictures barely matter if a little out of date, and Onshape caps how many
// API calls the app gets a year, so they're kept for 12 hours.
const PART_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// A part's bounding box, kept until the document changes. Shared by the
// card's size check and MAKE DRAWING.
function partBox(req, source, partId) {
  return cachedForSource(req, 'box', source, (src) => onshapeFetch(req,
    `/parts/${src.dwe}/partid/${encodeURIComponent(partId)}/boundingboxes${sourceQuery(src)}`), { extra: partId });
}

app.get('/api/onshape/part-shape', async (req, res) => {
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });
  const partId = String(req.query.partId || '');
  if (!/^[\x21-\x7E]{1,128}$/.test(partId)) return res.status(400).json({ error: 'Invalid part.' });

  try {
    const { source, partId: sourcePartId } = await resolvePart(req, partId);
    const box = await partBox(req, source, sourcePartId);
    const dims = [box.highX - box.lowX, box.highY - box.lowY, box.highZ - box.lowZ]
      .map((m) => m / METERS_PER_INCH)
      .sort((a, b) => a - b);
    const [small, mid, long] = dims;
    let shape = 'block';
    if (long >= 3 * mid && mid <= 1.3 * small && mid <= 2.5) shape = 'shaft';
    else if (small <= 0.5 && mid >= 4 * small) shape = 'plate';
    res.json({ shape, dims: dims.map((d) => Number(d.toFixed(4))), thickness: shape === 'plate' ? Number(small.toFixed(4)) : null });
  } catch (err) {
    console.error('Part shape lookup failed:', err.message);
    res.status(502).json({ error: err.status ? onshapeErrorMessage(err) : err.message });
  }
});

// A small isometric picture of one part, so a row like "Shaft" can be
// identified without touching the 3D view (Onshape can't highlight a part
// inside an assembly from an app; trying froze the feature list, PR #20).
const partImages = new Map();
const PART_IMAGE_MAX_AGE_MS = PART_CACHE_MAX_AGE_MS;
app.get('/api/onshape/part-image', async (req, res) => {
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });
  const partId = String(req.query.partId || '');
  if (!/^[\x21-\x7E]{1,128}$/.test(partId)) return res.status(400).json({ error: 'Invalid part.' });

  try {
    const { source, partId: sourcePartId } = await resolvePart(req, partId);
    // Shared by everyone who opens the same Part Studio, for 12 hours.
    const key = `${source.dwe}|${source.configuration || ''}|${sourcePartId}`;
    const cached = partImages.get(key);
    let png = cached && Date.now() - cached.at < PART_IMAGE_MAX_AGE_MS ? cached.png : null;
    if (!png) {
      const query = new URLSearchParams({
        viewMatrix: 'isometric', outputHeight: '200', outputWidth: '200', pixelSize: '0', edges: 'show', useAntiAliasing: 'true',
      });
      const view = await onshapeFetch(req,
        `/parts/${source.dwe}/partid/${encodeURIComponent(sourcePartId)}/shadedviews${sourceQuery(source, query)}`);
      const base64 = view.images && view.images[0];
      if (!base64) return res.status(404).json({ error: 'Onshape had no picture for this part.' });
      png = Buffer.from(base64, 'base64');
      if (partImages.size > 300) partImages.clear();
      partImages.set(key, { png, at: Date.now() });
    }
    res.set('Content-Type', 'image/png').set('Cache-Control', 'private, max-age=43200').send(png);
  } catch (err) {
    console.error('Part image failed:', err.message);
    res.status(502).json({ error: err.status ? onshapeErrorMessage(err) : err.message });
  }
});

// Twins: separate bodies with the same shape (a part copied in the Part
// Studio and given its own name) should share one part number. Mass
// properties find parts of the same size; twins.js then lines them up point
// by point: a copy (or a mirror of a symmetric part) shares the number, a
// true left/right mirror pair gets two numbers, and a part too symmetric to
// line up is left for the user to decide (SAME PART).
function firstNumber(v) { return Array.isArray(v) ? Number(v[0]) : Number(v); }

// Kept until the document changes.
function partMassProps(req, source) {
  return cachedForSource(req, 'mass', source, (src) => onshapeFetch(req, `/partstudios/${src.dwe}/massproperties${sourceQuery(src, new URLSearchParams({ massAsGroup: 'false' }))}`)
    .then((body) => {
      const out = new Map();
      for (const [partId, b] of Object.entries(body.bodies || {})) {
        if (partId === '-all-') continue;
        const volume = firstNumber(b.volume);
        const area = firstNumber(b.periphery);
        const mass = firstNumber(b.mass);
        const moments = (b.principalInertia || []).map(firstNumber);
        out.set(partId, {
          volume,
          area,
          moments: mass > 0 && moments.length === 3 ? moments.map((m) => m / mass).sort((x, y) => x - y) : null,
        });
      }
      return out;
    }));
}

// A first, cheap filter: copies agree to about 0.00001% in tests; 0.01%
// leaves room for Onshape's rounding. The point check makes the real call.
function sameShape(a, b) {
  const close = (x, y, tol) => Math.abs(x - y) <= tol * Math.max(Math.abs(x), Math.abs(y), 1e-12);
  if (!(a.volume > 0) || !close(a.volume, b.volume, 1e-4) || !close(a.area, b.area, 1e-4)) return false;
  if (a.moments && b.moments) return a.moments.every((m, i) => close(m, b.moments[i], 1e-3));
  return true;
}

app.post('/api/onshape/twins', express.json(), async (req, res) => {
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });
  const ids = (Array.isArray(req.body && req.body.partIds) ? req.body.partIds : [])
    .map(String).filter((id) => /^[\x21-\x7E]{1,128}$/.test(id)).slice(0, 500);

  try {
    const resolved = [];
    for (const id of ids) {
      try {
        resolved.push({ id, ...(await resolvePart(req, id)) });
      } catch (err) { /* gone from the list; skip */ }
    }
    const bySource = new Map();
    for (const r of resolved) {
      const key = sourceKey(req, r.source);
      if (!bySource.has(key)) bySource.set(key, { source: r.source, parts: [] });
      bySource.get(key).parts.push(r);
    }
    const fingerprints = [];
    await Promise.all([...bySource.values()].map(async ({ source, parts }) => {
      try {
        const props = await partMassProps(req, source);
        for (const r of parts) {
          const fp = props.get(r.partId);
          if (fp) fingerprints.push({ ...r, fp });
        }
      } catch (err) {
        console.error('Mass properties failed:', err.message);
      }
    }));

    // Same size by mass properties first (cheap), then line the parts up
    // point by point to tell copies from mirror images and near-misses.
    const sized = [];
    const used = new Set();
    for (let i = 0; i < fingerprints.length; i += 1) {
      if (used.has(i)) continue;
      const group = [fingerprints[i]];
      for (let j = i + 1; j < fingerprints.length; j += 1) {
        if (!used.has(j) && sameShape(fingerprints[i].fp, fingerprints[j].fp)) { group.push(fingerprints[j]); used.add(j); }
      }
      if (group.length > 1) sized.push(group);
    }

    const bodyOf = async (r) => {
      try {
        const { bodiesById } = await getBodyDetails(req, r.source);
        return bodiesById.get(r.partId) || null;
      } catch (err) {
        return null;
      }
    };
    const out = [];
    for (const group of sized) {
      // Copies collect into clusters; each pair of clusters is a mirror
      // pair, unknown (ask), or different (left alone).
      const clusters = [];
      for (const member of group) {
        const body = await bodyOf(member);
        const relations = [];
        let home = null;
        for (const cluster of clusters) {
          const relation = body && cluster.body ? compareBodies(cluster.body, body) : 'unknown';
          if (relation === 'same') { home = cluster; break; }
          relations.push({ cluster, relation });
        }
        if (home) { home.ids.push(member.id); continue; }
        const cluster = { ids: [member.id], body, links: relations };
        clusters.push(cluster);
      }
      for (const cluster of clusters) {
        if (cluster.ids.length > 1) out.push({ ids: cluster.ids, relation: 'same' });
        for (const { cluster: other, relation } of cluster.links) {
          if (relation === 'mirror' || relation === 'unknown') out.push({ ids: [...other.ids, ...cluster.ids], relation });
        }
      }
    }
    res.json({ groups: out });
  } catch (err) {
    console.error('Twin check failed:', err.message);
    res.status(502).json({ error: err.status ? onshapeErrorMessage(err) : err.message });
  }
});

// Every part in the Part Studio, for the panel's checklist.
// Names a part the same way across edits and versions (the list's own id
// changes whenever the document does), so the panel can remember choices
// like "this is COTS".
function stablePartKey(source, partId) {
  const src = asSource(source);
  const m = String(src.dwe || '').match(/^d\/([^/]+)\/[wvm]\/[^/]+\/e\/([^/]+)/);
  const raw = m ? [m[1], m[2], partId, src.configuration || ''].join('|') : `${src.dwe}|${partId}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

app.get('/api/onshape/parts', async (req, res) => {
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });

  // ?refresh=1 (the reload button) and ?fresh=1 (just before the part cards)
  // check the document's version right now; otherwise a check from the last
  // few seconds is trusted. Either way nothing is re-read unless the
  // document has changed.
  const maxAgeMs = req.query.refresh === '1' || req.query.fresh === '1' ? FRESH_MS : undefined;
  try {
    if (await elementType(req) === 'ASSEMBLY') {
      const list = await getAssemblyParts(req, { maxAgeMs, reuseDerived: req.query.fresh === '1' });
      return res.json({
        kind: 'assembly',
        parts: list.parts.map((p) => ({
          partId: p.id, name: p.name, material: p.material || null, quantity: p.quantity, group: p.group,
          linked: !isLocalSource(req.session.onshapeContext, p.source),
          onshapeKey: isLocalSource(req.session.onshapeContext, p.source)
            ? undefined : linkedPartKey(req.session.onshapeContext, p.source, p.partId),
          occurrences: p.occurrences,
          stableKey: stablePartKey(p.source, p.partId),
        })),
      });
    }
    const list = await getPartsList(req, dwe, { maxAgeMs });
    // The check before the cards only needs names and materials, so it keeps
    // the block CAD answer it already has.
    const derived = await derivedPartIds(req, dwe, { reuse: req.query.fresh === '1' });
    const parts = list
      .map((p) => ({
        partId: p.partId,
        name: p.name,
        material: p.material ? p.material.displayName : null,
        quantity: 1,
        group: withBlockCad(partGroup(p.name, false), derived.has(p.partId)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json({ kind: 'partstudio', parts });
  } catch (err) {
    console.error('Onshape parts list failed:', err);
    res.status(502).json({ error: onshapeErrorMessage(err) });
  }
});

app.get('/api/onshape/selected-part', async (req, res) => {
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });

  const selectionId = String(req.query.selectionId || '');
  // Onshape IDs use a base64-like alphabet ("S8O+D", "JH/"), so allow any
  // visible ASCII. The ID is only compared and sent in a JSON body, never put
  // in a URL path.
  if (!/^[\x21-\x7E]{1,128}$/.test(selectionId)) {
    return res.status(400).json({ error: 'Invalid selection.' });
  }

  try {
    // Clicks in an assembly name occurrences, not Part Studio faces; the
    // panel ticks assembly parts from its list instead.
    if (await elementType(req) === 'ASSEMBLY') {
      return res.status(409).json({ error: 'Pick parts from the list in assemblies.' });
    }
    // Clicks are answered from what's already known (no Onshape call).
    let index = await getPartIndex(req, dwe, { reuse: true });
    let partId = partIdFor(index, selectionId);
    let via = 'cache';

    if (!partId) {
      // Unknown ID: the model has probably changed since we last looked.
      // Check the version (one call) and re-read only if it really changed.
      index = await getPartIndex(req, dwe, { maxAgeMs: FRESH_MS });
      partId = partIdFor(index, selectionId);
      via = 'refresh';
    }

    if (!partId) {
      try {
        partId = await ownerViaFeatureScript(req, dwe, selectionId);
        via = 'featurescript';
      } catch (err) {
        console.error('FeatureScript owner lookup failed:', err);
      }
    }

    const part = index.partsById.get(partId);
    if (!part) {
      return res.status(404).json({ error: `Couldn't find which part ${selectionId} belongs to.` });
    }

    // A clicked face is what the DXF will be made from, if it's flat.
    const body = index.bodiesById.get(part.partId);
    const face = body && (body.faces || []).find((f) => f.id === selectionId);

    res.json({
      partId: part.partId,
      name: part.name,
      material: part.material ? part.material.displayName : null,
      faceId: face ? face.id : null,
      flatFace: face ? isPlanar(face) : null,
      via,
    });
  } catch (err) {
    console.error('Onshape selection lookup failed:', err);
    res.status(502).json({ error: onshapeErrorMessage(err) });
  }
});

// ---- Part namer ------------------------------------------------------------
// "Assign names": each part clicked in the Part Studio is renamed to the next
// number in a series like 26O-E001. Renaming changes the document, so it
// needs the app's "edit" (OAuth2Write) permission.
const NAME_PREFIX = /^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/;
// Onshape's "Name" property has the same ID on every part, so it's looked up
// once (one extra call) and then each rename is a single call.
let namePropertyId = null;
const PART_NAME = /^[\w .\-()#/]{1,80}$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The next free number after the highest one already used, in this Part
// Studio or (when a project is picked) in LUNA Parts.
app.get('/api/onshape/next-number', async (req, res) => {
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });
  const prefix = String(req.query.prefix || '');
  if (!NAME_PREFIX.test(prefix)) return res.status(400).json({ error: 'Use letters, numbers and dashes for the prefix, like 26O-E.' });
  const projectId = Number(req.query.project_id);

  // Parts about to be renumbered don't hold on to their old numbers.
  const exclude = new Set(String(req.query.exclude || '').split(',').filter(Boolean).slice(0, 1000));

  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)\\b`, 'i');
  const numbers = [];
  let lunaHighest = 0;
  try {
    // Renames made from the panel are already in the cached lists.
    const names = await elementType(req) === 'ASSEMBLY'
      ? (await getAssemblyParts(req)).parts.filter((p) => !exclude.has(p.id)).map((p) => p.name)
      : (await getPartsList(req, dwe)).filter((p) => !exclude.has(p.partId)).map((p) => p.name);
    for (const name of names) {
      const m = String(name || '').match(pattern);
      if (m) numbers.push(Number(m[1]));
    }
  } catch (err) {
    console.error('Onshape parts list failed:', err);
    return res.status(502).json({ error: onshapeErrorMessage(err) });
  }
  let checkedLuna = false;
  if (Number.isInteger(projectId) && projectId > 0) {
    try {
      const parts = await lunaGetAll(`parts?project_id=${projectId}`);
      for (const part of parts) {
        const m = String(part.part_number || '').match(pattern);
        if (m) { numbers.push(Number(m[1])); lunaHighest = Math.max(lunaHighest, Number(m[1])); }
      }
      checkedLuna = true;
    } catch (err) {
      console.error('LUNA Parts lookup for next number failed:', err);
    }
  }
  res.json({ next: (numbers.length ? Math.max(...numbers) : 0) + 1, checkedLuna, lunaHighest });
});

app.post('/api/onshape/rename', express.json(), async (req, res) => {
  const ctx = req.session.onshapeContext;
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });
  const partId = String((req.body && req.body.partId) || '');
  const name = String((req.body && req.body.name) || '').trim();
  if (!/^[\x21-\x7E]{1,128}$/.test(partId)) return res.status(400).json({ error: 'Invalid part.' });
  if (!PART_NAME.test(name)) return res.status(400).json({ error: 'That name has characters Onshape parts can\'t use here.' });

  try {
    // In an assembly, rename the part in its own Part Studio. That only works
    // for parts made in this document: parts linked in from elsewhere (FRC
    // Design App, other documents, saved versions) can't be changed from here.
    let target = { dwe, partId, configuration: '' };
    let assemblyPart = null;
    if (await elementType(req) === 'ASSEMBLY') {
      const list = await getAssemblyParts(req, { reuse: true });
      assemblyPart = list.byId.get(partId);
      if (!assemblyPart) return res.status(404).json({ error: 'Couldn\'t find that part in the assembly any more. Refresh the list.' });
      if (!isLocalSource(ctx, assemblyPart.source)) {
        return res.status(409).json({ error: 'This part is linked from another document, so Onshape can\'t rename it here.', linked: true });
      }
      target = { dwe: assemblyPart.source.dwe, partId: assemblyPart.partId, configuration: assemblyPart.source.configuration };
    }
    const query = target.configuration ? `?configuration=${encodeURIComponent(target.configuration)}` : '';
    const path = `/metadata/${target.dwe}/p/${encodeURIComponent(target.partId)}${query}`;
    // Look up the Name property's ID rather than hard-coding it (once).
    if (!namePropertyId) {
      const meta = await onshapeFetch(req, path);
      const nameProp = (meta.properties || []).find((p) => p.name === 'Name');
      if (!nameProp) return res.status(502).json({ error: 'Onshape didn\'t list a Name property for this part.' });
      namePropertyId = nameProp.propertyId;
    }
    try {
      await onshapeFetch(req, path, {
        method: 'POST',
        body: JSON.stringify({
          jsonType: 'metadata-part',
          partId: target.partId,
          properties: [{ propertyId: namePropertyId, value: name }],
        }),
      });
    } catch (err) {
      // Look the ID up again next time, in case it was wrong.
      if (err.status === 400 || err.status === 404) namePropertyId = null;
      throw err;
    }

    // Keep the cached part list in step so the checklist shows the new name.
    if (assemblyPart) {
      assemblyPart.name = name;
      assemblyPart.group = partGroup(name, false);
    } else {
      const cached = (await getPartsById(req, dwe, { reuse: true })).get(partId);
      if (cached) cached.name = name;
    }
    res.json({ partId, name });
  } catch (err) {
    console.error('Onshape rename failed:', err);
    if (err.status === 403) {
      return res.status(403).json({
        error: 'The app can\'t edit Onshape yet. In the Onshape developer portal, give the app "write to your documents" permission, then click Reconnect to Onshape.',
        needsWrite: true,
      });
    }
    res.status(502).json({ error: err.status ? `Onshape couldn't rename the part (${err.status}).` : 'Could not reach Onshape.' });
  }
});

// Drawing tabs in the current document, for the panel's Drawing picker.
app.get('/api/onshape/drawings', async (req, res) => {
  const ctx = req.session.onshapeContext;
  if (!req.session.onshapeTokens || !ctx) {
    return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });
  }

  try {
    // Onshape drawings are "application" elements, not their own element
    // type, so list everything and keep the ones whose data type is a drawing.
    const elements = await getElements(req, { maxAgeMs: req.query.refresh === '1' ? FRESH_MS : undefined });
    res.json({
      drawings: elements
        .filter((e) => e.elementType === 'DRAWING'
          || (e.elementType === 'APPLICATION' && /drawing/i.test(e.dataType || '')))
        .map((e) => ({ id: e.id, name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    });
  } catch (err) {
    console.error('Onshape drawings lookup failed:', err);
    res.status(502).json({ error: err.status === 402 ? API_LIMIT_MESSAGE : 'Could not list drawings from Onshape.' });
  }
});

// Makes an Onshape drawing for a part that doesn't have one yet, in the
// team's layout for its type (see drawings.js). The new tab is named
// "<part number> Drawing 1", so the panel's drawing matching picks it up.
app.post('/api/onshape/make-drawing', express.json(), async (req, res) => {
  const ctx = req.session.onshapeContext;
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });
  const b = req.body || {};
  const partId = String(b.partId || '');
  const partNumber = String(b.partNumber || '').trim();
  const qty = Math.max(1, Math.min(9999, parseInt(b.quantity, 10) || 1));
  const material = String(b.material || '').slice(0, 80);
  if (!/^[\x21-\x7E]{1,128}$/.test(partId)) return res.status(400).json({ error: 'Invalid part.' });
  if (!partNumber || partNumber.length > 80) return res.status(400).json({ error: 'Give the part a number first.' });

  try {
    const { source, partId: sourcePartId } = await resolvePart(req, partId);
    const m = source.dwe.match(/^d\/([0-9a-f]{24})\/(w|v|m)\/([0-9a-f]{24})\/e\/([0-9a-f]{24})$/);
    if (!m) return res.status(400).json({ error: 'Couldn\'t find the part\'s Part Studio.' });
    const [, did, wvm, wvmId, eid] = m;
    // A drawing can show a part from this document, or from a saved version
    // of another document, but not another document's live workspace.
    let reference;
    if (did === ctx.documentId && wvm === 'w') reference = { elementId: eid, idTag: sourcePartId };
    else if (wvm === 'v') reference = { documentId: did, versionId: wvmId, elementId: eid, idTag: sourcePartId };
    else return res.status(409).json({ error: 'This part comes from another document that isn\'t at a saved version, so no drawing can be made here.' });
    if (source.configuration) reference.configuration = source.configuration;

    // Don't make a second drawing when one already exists for this part.
    // Checked fresh (one call, or none if nothing changed) so a drawing made
    // a moment ago isn't made twice.
    const elements = await getElements(req, { maxAgeMs: 5000 });
    const drawings = elements.filter((e) => e.elementType === 'DRAWING'
      || (e.elementType === 'APPLICATION' && /drawing/i.test(e.dataType || '')));
    const key = partNumber.split(/\s+/)[0].toUpperCase();
    const existing = drawings.find((e) => String(e.name || '').split(/\s+/)[0].toUpperCase() === key);
    if (existing && !b.force) return res.json({ drawingId: existing.id, name: existing.name, existing: true, warnings: [] });
    let n = 1;
    const names = new Set(drawings.map((e) => e.name));
    while (names.has(`${partNumber} Drawing ${n}`)) n += 1;
    const name = `${partNumber} Drawing ${n}`;

    const index = await getPartIndexWith(req, source, sourcePartId);
    const body = index.bodiesById.get(sourcePartId);
    if (!body) return res.status(404).json({ error: 'Couldn\'t read the part\'s shape from Onshape.' });
    const box = await partBox(req, source, sourcePartId);

    const result = await makeDrawing({
      api: (path, options) => onshapeFetch(req, path, options),
      ctx,
      reference,
      body,
      box,
      name,
      partNumber,
      qty,
      material,
      exportJson: async (drawingEid) => JSON.parse(String(await runTranslation(req,
        `/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${drawingEid}/translations`,
        { formatName: 'DRAWING_JSON', storeInDocument: false, level: 'full' }, ctx.documentId, 'drawing data'))),
    });
    // The document now has a new tab; the next Drawing list reads it again.
    elementLists.delete(docKeyOf(ctx));
    res.json(result);
  } catch (err) {
    console.error('Make drawing failed:', err);
    if (err.status === 403) {
      return res.status(403).json({
        error: 'The app can\'t edit Onshape yet. In the Onshape developer portal, give the app "write to your documents" permission, then click Reconnect to Onshape.',
        needsWrite: true,
      });
    }
    res.status(502).json({ error: err.status === 401 || err.status === 402 ? onshapeErrorMessage(err) : err.status ? `Onshape couldn't make the drawing (${err.status}): ${String(err.message).split(': ').slice(1).join(': ').slice(0, 200)}` : err.message });
  }
});

// ---- LUNA Parts ---------------------------------------------------------
// The API key lives only in Render's env vars and is only ever sent from
// this server, so the panel (and anyone viewing it) never sees it.
const LUNA_API_BASE = (process.env.LUNA_PARTS_API_BASE || 'https://build.lunatecs.org/api/v1').replace(/\/+$/, '');

// LUNA Parts returns lists one page at a time; this follows next_page_url
// until it has everything (capped so a bad response can't loop forever).
async function lunaGetAll(resource) {
  const items = [];
  let url = `${LUNA_API_BASE}/${resource}`;

  for (let page = 0; url && page < 20; page++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.LUNA_PARTS_API_KEY}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const err = new Error(`LUNA Parts ${resource} returned ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const body = await res.json();
    items.push(...body.data);
    url = body.next_page_url;
  }

  return items;
}

// Read-only: fetches the lists the panel needs for its dropdowns. Requires
// an Onshape login so the team's project list isn't public on this URL.
app.get('/api/luna/options', async (req, res) => {
  if (!req.session.onshapeTokens) {
    return res.status(401).json({ error: 'Log in with Onshape first.' });
  }
  if (!process.env.LUNA_PARTS_API_KEY) {
    return res.status(500).json({ error: 'LUNA_PARTS_API_KEY is not set on the server.' });
  }

  try {
    const [projects, tools, thicknesses] = await Promise.all([
      lunaGetAll('projects'),
      lunaGetAll('tools'),
      lunaGetAll('material-thicknesses'),
    ]);

    res.json({
      projects: projects
        .filter((p) => !p.completed_at)
        .map((p) => ({ id: p.id, name: p.name, prefix: p.part_number_prefix })),
      tools: tools
        .filter((t) => t.is_active)
        .sort((a, b) => a.order - b.order)
        .map((t) => ({ id: t.id, name: t.name })),
      thicknesses: thicknesses
        .sort((a, b) => a.order - b.order)
        .map((t) => ({ id: t.id, name: t.name })),
    });
  } catch (err) {
    console.error('LUNA Parts request failed:', err);
    const message = err.status === 401
      ? 'LUNA Parts rejected the API key.'
      : err.status === 403
        ? 'The API key\'s user isn\'t allowed to read this.'
        : `Could not reach LUNA Parts (${err.status ? `it answered ${err.status}` : (err.cause && err.cause.code) || err.message || 'network error'}).`;
    res.status(502).json({ error: message });
  }
});

// Read-only: every part number already in LUNA, so the panel can fold away
// parts that have been uploaded.
app.get('/api/luna/part-numbers', async (req, res) => {
  if (!req.session.onshapeTokens) {
    return res.status(401).json({ error: 'Log in with Onshape first.' });
  }
  try {
    const parts = await lunaGetAll('parts');
    const linked = {};
    for (const p of parts) {
      const m = String(p.notes || '').match(ONSHAPE_TAG);
      const number = String(p.part_number || '').trim();
      if (m && number && !linked[m[1]]) linked[m[1]] = number;
    }
    res.json({
      partNumbers: [...new Set(parts.map((p) => String(p.part_number || '').trim()).filter(Boolean))],
      linked,
    });
  } catch (err) {
    console.error('LUNA Parts part-number list failed:', err);
    res.status(502).json({ error: 'Could not read part numbers from LUNA Parts.' });
  }
});

// Read-only: assemblies in one project, for the "Parent Assembly" dropdown.
// The API mentions a project_id filter without documenting it, so we pass
// it and also filter here in case it's ignored.
app.get('/api/luna/assemblies', async (req, res) => {
  if (!req.session.onshapeTokens) {
    return res.status(401).json({ error: 'Log in with Onshape first.' });
  }
  const projectId = Number(req.query.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'project_id is required.' });
  }

  try {
    const parts = await lunaGetAll(`parts?project_id=${projectId}`);
    res.json({
      assemblies: parts
        .filter((p) => p.project_id === projectId && p.type === 'assembly')
        .map((p) => ({ id: p.id, name: p.name, partNumber: p.part_number })),
    });
  } catch (err) {
    console.error('LUNA Parts request failed:', err);
    res.status(502).json({ error: 'Could not load assemblies from LUNA Parts.' });
  }
});

// The API has no endpoint that lists part statuses, but every part carries
// a part_status_id, and fetching a single part includes its status. So we
// collect the IDs in use and look up one example part for each to get the
// status's name. Statuses rarely change, so the answer is cached.
const STATUS_CACHE_MS = 10 * 60 * 1000;
let statusCache = null;

function statusName(part) {
  const status = part.status || part.part_status || part.partStatus;
  if (!status || typeof status !== 'object') return null;
  return status.name || status.label || status.title || null;
}

async function lunaGet(path) {
  const res = await fetch(`${LUNA_API_BASE}/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.LUNA_PARTS_API_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const err = new Error(`LUNA Parts ${path} returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function loadStatuses() {
  const parts = await lunaGetAll('parts');
  const examples = new Map();
  for (const part of parts) {
    if (!examples.has(part.part_status_id)) examples.set(part.part_status_id, part);
  }

  const statuses = await Promise.all([...examples].map(async ([id, part]) => {
    let name = statusName(part);
    if (!name) {
      try {
        name = statusName(await lunaGet(`parts/${part.id}`));
      } catch (err) {
        console.error(`Could not look up status ${id}:`, err);
      }
    }
    return { id, name: name || `Status ${id}` };
  }));

  return statuses.sort((a, b) => a.id - b.id);
}

app.get('/api/luna/statuses', async (req, res) => {
  if (!req.session.onshapeTokens) {
    return res.status(401).json({ error: 'Log in with Onshape first.' });
  }

  try {
    if (!statusCache || Date.now() - statusCache.at > STATUS_CACHE_MS) {
      statusCache = { at: Date.now(), statuses: await loadStatuses() };
    }
    res.json({ statuses: statusCache.statuses });
  } catch (err) {
    console.error('LUNA Parts status lookup failed:', err);
    res.status(502).json({ error: 'Could not load part statuses from LUNA Parts.' });
  }
});

// Creates the part in LUNA Parts. This writes to the team's real tracker,
// so it refuses to create a second part with the same part number in the
// same project (updating an existing part is a separate, later step).
const PART_TYPES = ['part', 'assembly', 'purchased'];

function optionalNumber(value, { integer = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) return NaN;
  return n;
}

// The signed-in Onshape user's name, read once per session.
async function onshapeUserName(req) {
  if (req.session.onshapeUserName !== undefined) return req.session.onshapeUserName;
  try {
    const info = await onshapeFetch(req, '/users/sessioninfo');
    const name = String(info.name || [info.firstName, info.lastName].filter(Boolean).join(' ') || '').trim().slice(0, 80);
    req.session.onshapeUserName = name;
    return name;
  } catch (err) {
    console.error('Onshape user lookup failed:', err.message);
    return '';
  }
}

app.post('/api/luna/parts', express.json(), async (req, res) => {
  if (!req.session.onshapeTokens) {
    return res.status(401).json({ error: 'Log in with Onshape first.' });
  }

  const b = req.body || {};
  const fields = {
    project_id: optionalNumber(b.projectId, { integer: true }),
    name: String(b.name || '').trim(),
    part_number: String(b.partNumber || '').trim(),
    part_status_id: optionalNumber(b.statusId, { integer: true }),
    type: b.type,
    quantity: optionalNumber(b.quantity, { integer: true }),
    tool_id: optionalNumber(b.toolId, { integer: true }),
    priority: optionalNumber(b.priority, { integer: true }),
    parent_part_id: optionalNumber(b.parentPartId, { integer: true }),
    material: String(b.material || '').trim(),
    material_thickness_id: optionalNumber(b.thicknessId, { integer: true }),
    cut_length: optionalNumber(b.cutLength),
    lead_time_days: optionalNumber(b.leadTimeDays, { integer: true }),
    description: String(b.description || '').trim(),
  };

  const problems = [];
  if (!fields.project_id) problems.push('Choose a project.');
  if (!fields.name) problems.push('Enter a name.');
  if (!fields.part_status_id) problems.push('Choose a status.');
  if (!PART_TYPES.includes(fields.type)) problems.push('Choose a type.');
  if (fields.quantity === null || Number.isNaN(fields.quantity)) problems.push('Quantity must be a whole number.');
  for (const key of ['tool_id', 'priority', 'parent_part_id', 'material_thickness_id', 'cut_length', 'lead_time_days']) {
    if (Number.isNaN(fields[key])) problems.push(`${key.replace(/_/g, ' ')} isn't a valid number.`);
  }
  if (problems.length) return res.status(400).json({ error: problems.join(' ') });

  // Everyone uploads through the panel's one LUNA key, so the notes say
  // which Onshape user made the part.
  const who = await onshapeUserName(req);
  const notes = who ? [`Uploaded by ${who} (Onshape, via Luna Parts Bridge)`] : [];

  // A linked assembly part gets the tag that ties its LUNA number to it.
  const panelPartId = String(b.onshapePartId || '');
  if (/^a[0-9a-f]{12}$/.test(panelPartId) && req.session.onshapeContext) {
    try {
      const list = await getAssemblyParts(req, { reuse: true });
      const part = list.byId.get(panelPartId);
      const ctx = req.session.onshapeContext;
      const key = part && !isLocalSource(ctx, part.source) && linkedPartKey(ctx, part.source, part.partId);
      if (key) notes.push(`[onshape:${key}]`);
    } catch (err) {
      console.error('Linked part lookup failed:', err.message);
    }
  }

  if (notes.length) fields.notes = notes.join('\n');

  try {
    if (fields.part_number) {
      const existing = await lunaGetAll(`parts?project_id=${fields.project_id}`);
      const duplicate = existing.find((p) => p.project_id === fields.project_id
        && String(p.part_number).toLowerCase() === fields.part_number.toLowerCase());
      if (duplicate) {
        return res.status(409).json({
          error: `${duplicate.part_number} already exists in this project ("${duplicate.name}"), so nothing was created.`,
        });
      }
    }

    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== null && value !== '') form.append(key, String(value));
    }

    const lunaRes = await fetch(`${LUNA_API_BASE}/parts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LUNA_PARTS_API_KEY}`,
        Accept: 'application/json',
      },
      body: form,
    });
    const body = await lunaRes.json().catch(() => ({}));

    if (lunaRes.status === 422) {
      const details = Object.values(body.errors || {}).flat().join(' ');
      return res.status(422).json({ error: details || body.message || 'LUNA Parts rejected the part.' });
    }
    if (!lunaRes.ok) {
      console.error('LUNA Parts create failed:', lunaRes.status, body);
      const message = lunaRes.status === 403
        ? 'The API key\'s LUNA Parts user isn\'t allowed to create parts (it needs editor access).'
        : `LUNA Parts returned an error (${lunaRes.status}).`;
      return res.status(502).json({ error: message });
    }

    const created = body.data || body;
    res.status(201).json({ id: created.id, partNumber: created.part_number, name: created.name });
  } catch (err) {
    console.error('LUNA Parts create failed:', err);
    res.status(502).json({ error: 'Could not reach LUNA Parts.' });
  }
});

// ---- Attachments: the part's DXF and drawing PDF -------------------------
// After Create Part, the panel sends the Onshape part (and the face that was
// clicked, and the chosen drawing). We build the DXF from the face, export
// the drawing to PDF through Onshape's translation service (read-only access
// is enough; nothing is saved back into the document), and upload both to
// the LUNA part's attachments. One failing doesn't stop the other.
const TRANSLATION_TIMEOUT_MS = 60 * 1000;

function safeFileName(text) {
  return String(text || 'part').replace(/[^\w.\- ]+/g, '_').trim().slice(0, 80) || 'part';
}

async function buildDxf(req, source, partId, faceId) {
  let details = await getBodyDetails(req, source);
  if (!details.bodiesById.has(partId) && !isFrozenSource(asSource(source))) details = await getBodyDetails(req, source, { maxAgeMs: FRESH_MS });
  const body = details.bodiesById.get(partId);
  if (!body) throw new Error('Couldn\'t find the part in Onshape to make its DXF.');

  // Splines and other curves need their tessellated points from Onshape.
  const { face } = pickFace(body, faceId);
  const edgePoints = new Map();
  const extra = face ? edgesNeedingPoints(body, face) : [];
  if (extra.length) {
    const query = new URLSearchParams({ partId });
    for (const id of extra) query.append('edgeId', id);
    const tess = await onshapeFetch(req, `/partstudios/${source.dwe}/tessellatededges${sourceQuery(source, query)}`);
    for (const b of tess.bodies || []) {
      for (const e of b.edges || []) edgePoints.set(e.id, e.vertices || []);
    }
  }
  return faceToDxf(body, faceId, edgePoints);
}

// Starts an Onshape export, waits for it, and returns the file's bytes.
async function runTranslation(req, path, params, documentId, what, linkDocumentId = '') {
  const started = await onshapeFetch(req, path, { method: 'POST', body: JSON.stringify(params) });
  const deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
  let info = started;
  // Each status check is an Onshape call, so wait longer between them as
  // the export goes on (2 s, 3 s, 4 s, then every 5 s) instead of every second.
  let wait = 2000;
  while (info.requestState === 'ACTIVE') {
    if (Date.now() + wait > deadline) throw new Error(`Onshape took too long to export the ${what}.`);
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait + 1000, 5000);
    info = await onshapeFetch(req, `/translations/${started.id}`);
  }
  if (info.requestState !== 'DONE' || !(info.resultExternalDataIds || []).length) {
    throw new Error(`Onshape couldn't export the ${what}${info.failureReason ? `: ${info.failureReason}` : '.'}`);
  }
  const link = linkDocumentId ? `?linkDocumentId=${linkDocumentId}` : '';
  return onshapeFetch(req, `/documents/d/${documentId}/externaldata/${info.resultExternalDataIds[0]}${link}`, { raw: true });
}

// A STEP of one part, from its own Part Studio. Exports can only run against
// a workspace or a version, not an older microversion.
async function exportStep(req, source, partId, name) {
  const m = source.dwe.match(/^d\/([0-9a-f]{24})\/(w|v|m)\/([0-9a-f]{24})\/e\/([0-9a-f]{24})$/);
  if (!m) throw new Error('Couldn\'t find the part\'s Part Studio for the STEP file.');
  if (m[2] === 'm') throw new Error('This part comes from another document that isn\'t at a saved version, so no STEP was made.');
  return runTranslation(req, `/partstudios/${source.dwe}/translations`, {
    formatName: 'STEP',
    storeInDocument: false,
    partIds: partId,
    destinationName: name,
    ...(source.configuration ? { configuration: source.configuration } : {}),
    ...(source.linkDocumentId ? { linkDocumentId: source.linkDocumentId } : {}),
  }, m[1], 'STEP file', source.linkDocumentId);
}

async function exportDrawingPdf(req, ctx, drawingId, name) {
  return runTranslation(req,
    `/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${drawingId}/translations`, {
      formatName: 'PDF',
      storeInDocument: false,
      currentSheetOnly: false,
      destinationName: name,
    }, ctx.documentId, 'drawing PDF');
}

app.post('/api/luna/parts/:id/attachments', express.json(), async (req, res) => {
  const ctx = req.session.onshapeContext;
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });

  const lunaPartId = optionalNumber(req.params.id, { integer: true });
  const b = req.body || {};
  const partId = String(b.partId || '');
  const faceId = b.faceId ? String(b.faceId) : null;
  const drawingId = b.drawingId ? String(b.drawingId) : null;
  // DXFs are only for parts cut on the CNC; the panel decides from the Machine.
  const wantDxf = b.wantDxf !== false;
  const wantStep = b.wantStep === true;
  const fileBase = safeFileName(b.partNumber);
  if (!lunaPartId) return res.status(400).json({ error: 'Invalid LUNA part.' });
  if (!/^[\x21-\x7E]{1,128}$/.test(partId) || (faceId && !/^[\x21-\x7E]{1,128}$/.test(faceId))) {
    return res.status(400).json({ error: 'Click the part in Onshape first.' });
  }
  if (drawingId && !ONSHAPE_ID.test(drawingId)) return res.status(400).json({ error: 'Invalid drawing.' });

  const files = [];
  const notes = [];

  let resolved;
  try {
    resolved = await resolvePart(req, partId);
  } catch (err) {
    console.error('Part lookup for attachments failed:', err);
    return res.status(502).json({ error: err.status ? onshapeErrorMessage(err) : err.message });
  }

  const [dxf, pdf, step] = await Promise.allSettled([
    wantDxf ? buildDxf(req, resolved.source, resolved.partId, faceId) : Promise.resolve(null),
    drawingId ? exportDrawingPdf(req, ctx, drawingId, `${fileBase} drawing`) : Promise.resolve(null),
    wantStep ? exportStep(req, resolved.source, resolved.partId, fileBase) : Promise.resolve(null),
  ]);

  if (!wantDxf) {
    // Not a CNC part: no DXF wanted, so nothing to report.
  } else if (dxf.status === 'fulfilled') {
    files.push({ name: `${fileBase}.dxf`, type: 'application/dxf', data: dxf.value.dxf });
    const reamed = dxf.value.reamed || [];
    if (reamed.length) {
      const sizes = [...new Set(reamed)].map((d) => `${d.toFixed(3)}"`).join(' and ');
      notes.push(`${reamed.length} bearing hole${reamed.length === 1 ? '' : 's'} (${sizes}) cut ${REAM_UNDERSIZE_IN.toFixed(3)}" small for reaming.`);
    }
    if (faceId && !dxf.value.usedClicked) notes.push('The clicked face isn\'t flat, so the DXF uses the part\'s largest flat face.');
  } else {
    console.error('DXF build failed:', dxf.reason);
    notes.push(dxf.reason.status ? 'Couldn\'t read the part from Onshape for the DXF.' : dxf.reason.message);
  }
  if (!drawingId) {
    notes.push('No drawing was chosen, so no PDF was attached.');
  } else if (pdf.status === 'fulfilled') {
    files.push({ name: `${fileBase} drawing.pdf`, type: 'application/pdf', data: pdf.value });
  } else {
    console.error('Drawing PDF export failed:', pdf.reason);
    notes.push(pdf.reason.status ? `Couldn't export the drawing PDF (Onshape ${pdf.reason.status}).` : pdf.reason.message);
  }

  if (wantStep) {
    if (step.status === 'fulfilled') {
      files.push({ name: `${fileBase}.step`, type: 'application/step', data: step.value });
    } else {
      console.error('STEP export failed:', step.reason);
      notes.push(step.reason.status ? `Couldn't export the STEP file (Onshape ${step.reason.status}).` : step.reason.message);
    }
  }

  if (!files.length) return res.status(502).json({ error: 'Nothing was attached.', notes });

  try {
    const form = new FormData();
    for (const f of files) form.append('files[]', new Blob([f.data], { type: f.type }), f.name);

    const lunaRes = await fetch(`${LUNA_API_BASE}/parts/${lunaPartId}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LUNA_PARTS_API_KEY}`,
        Accept: 'application/json',
      },
      body: form,
    });
    if (!lunaRes.ok) {
      const body = await lunaRes.json().catch(() => ({}));
      console.error('LUNA Parts attachment upload failed:', lunaRes.status, body);
      const details = lunaRes.status === 422 ? Object.values(body.errors || {}).flat().join(' ') : '';
      return res.status(502).json({
        error: details || `LUNA Parts didn't accept the files (${lunaRes.status}).`,
        notes,
      });
    }
    res.json({ attached: files.map((f) => f.name), notes });
  } catch (err) {
    console.error('LUNA Parts attachment upload failed:', err);
    res.status(502).json({ error: 'Could not reach LUNA Parts to upload the files.', notes });
  }
});

app.listen(PORT, () => {
  console.log(`Luna Parts Bridge listening on port ${PORT}`);
});
