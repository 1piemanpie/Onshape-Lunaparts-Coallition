const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

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
  const tokens = req.session.onshapeTokens;
  if (tokens && tokens.expiresAt > Date.now()) {
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

async function onshapeFetch(req, path, options = {}) {
  const res = await fetch(`${ONSHAPE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${req.session.onshapeTokens.accessToken}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`Onshape ${path} returned ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
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

const PART_INDEX_MAX_AGE_MS = 30 * 1000;
const partIndexes = new Map();

async function fetchPartIndex(req, dwe) {
  const [parts, details] = await Promise.all([
    onshapeFetch(req, `/parts/${dwe}`),
    onshapeFetch(req, `/partstudios/${dwe}/bodydetails`),
  ]);

  const partsById = new Map(parts.map((p) => [p.partId, p]));
  const entityToPart = new Map();
  for (const body of details.bodies || []) {
    for (const kind of ['faces', 'edges', 'vertices']) {
      for (const entity of body[kind] || []) entityToPart.set(entity.id, body.id);
    }
  }
  return { partsById, entityToPart, fetchedAt: Date.now() };
}

// Concurrent callers share one in-flight download.
function getPartIndex(req, dwe, { refresh = false } = {}) {
  const key = `${req.sessionID}:${dwe}`;
  const cached = partIndexes.get(key);
  if (cached && !refresh) return cached;

  if (partIndexes.size > 100) partIndexes.clear();
  const loading = fetchPartIndex(req, dwe);
  partIndexes.set(key, loading);
  loading.catch(() => partIndexes.delete(key));
  return loading;
}

const backgroundRefreshes = new Set();

function refreshPartIndexInBackground(req, dwe) {
  const key = `${req.sessionID}:${dwe}`;
  if (backgroundRefreshes.has(key)) return;
  backgroundRefreshes.add(key);
  fetchPartIndex(req, dwe)
    .then((index) => partIndexes.set(key, Promise.resolve(index)))
    .catch((err) => console.error('Background part index refresh failed:', err))
    .finally(() => backgroundRefreshes.delete(key));
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

function onshapeErrorMessage(err) {
  return err.status === 401
    ? 'Your Onshape login expired. Close and reopen the panel.'
    : `Could not read parts from Onshape (${err.status || 'network error'}).`;
}

function currentDwe(req) {
  const ctx = req.session.onshapeContext;
  if (!req.session.onshapeTokens || !ctx) return null;
  return `d/${ctx.documentId}/w/${ctx.workspaceId}/e/${ctx.elementId}`;
}

// Called when the panel opens so the first click is already fast.
app.post('/api/onshape/warm', async (req, res) => {
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });

  try {
    const index = await getPartIndex(req, dwe);
    res.json({ parts: index.partsById.size });
  } catch (err) {
    console.error('Onshape part index load failed:', err);
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
    let index = await getPartIndex(req, dwe);
    let partId = partIdFor(index, selectionId);
    let via = 'cache';

    if (!partId) {
      // Unknown ID: the model has probably changed since we last looked.
      index = await getPartIndex(req, dwe, { refresh: true });
      partId = partIdFor(index, selectionId);
      via = 'refresh';
    } else if (Date.now() - index.fetchedAt > PART_INDEX_MAX_AGE_MS) {
      // Answer from cache now, but pick up renames/material changes for next
      // time. The old index keeps serving clicks until the new one is ready.
      refreshPartIndexInBackground(req, dwe);
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

    res.json({
      partId: part.partId,
      name: part.name,
      material: part.material ? part.material.displayName : null,
      via,
    });
  } catch (err) {
    console.error('Onshape selection lookup failed:', err);
    res.status(502).json({ error: onshapeErrorMessage(err) });
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
    const elements = await onshapeFetch(req,
      `/documents/d/${ctx.documentId}/w/${ctx.workspaceId}/elements`);
    res.json({
      drawings: elements
        .filter((e) => e.elementType === 'DRAWING'
          || (e.elementType === 'APPLICATION' && /drawing/i.test(e.dataType || '')))
        .map((e) => ({ id: e.id, name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    });
  } catch (err) {
    console.error('Onshape drawings lookup failed:', err);
    res.status(502).json({ error: 'Could not list drawings from Onshape.' });
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
        : 'Could not reach LUNA Parts.';
    res.status(502).json({ error: message });
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

app.listen(PORT, () => {
  console.log(`Parts Tracker Bridge listening on port ${PORT}`);
});
