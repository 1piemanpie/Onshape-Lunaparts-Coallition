const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { faceToDxf, edgesNeedingPoints, isPlanar, pickFace } = require('./dxf');

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

// { raw: true } returns the file bytes (a Buffer) instead of parsed JSON.
async function onshapeFetch(req, path, { raw = false, ...options } = {}) {
  const res = await fetch(`${ONSHAPE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${req.session.onshapeTokens.accessToken}`,
      Accept: raw ? 'application/octet-stream' : 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`Onshape ${path} returned ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
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
  const bodiesById = new Map();
  const entityToPart = new Map();
  for (const body of details.bodies || []) {
    bodiesById.set(body.id, body);
    for (const kind of ['faces', 'edges', 'vertices']) {
      for (const entity of body[kind] || []) entityToPart.set(entity.id, body.id);
    }
  }
  // The face/edge geometry is kept too, for making DXFs.
  return { partsById, bodiesById, entityToPart, fetchedAt: Date.now() };
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

async function buildDxf(req, dwe, partId, faceId) {
  let index = await getPartIndex(req, dwe);
  if (!index.bodiesById.has(partId)) index = await getPartIndex(req, dwe, { refresh: true });
  const body = index.bodiesById.get(partId);
  if (!body) throw new Error('Couldn\'t find the part in Onshape to make its DXF.');

  // Splines and other curves need their tessellated points from Onshape.
  const { face } = pickFace(body, faceId);
  const edgePoints = new Map();
  const extra = face ? edgesNeedingPoints(body, face) : [];
  if (extra.length) {
    const query = new URLSearchParams({ partId });
    for (const id of extra) query.append('edgeId', id);
    const tess = await onshapeFetch(req, `/partstudios/${dwe}/tessellatededges?${query}`);
    for (const b of tess.bodies || []) {
      for (const e of b.edges || []) edgePoints.set(e.id, e.vertices || []);
    }
  }
  return faceToDxf(body, faceId, edgePoints);
}

async function exportDrawingPdf(req, ctx, drawingId, name) {
  const started = await onshapeFetch(req,
    `/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${drawingId}/translations`, {
      method: 'POST',
      body: JSON.stringify({
        formatName: 'PDF',
        storeInDocument: false,
        currentSheetOnly: false,
        destinationName: name,
      }),
    });

  const deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
  let info = started;
  while (info.requestState === 'ACTIVE') {
    if (Date.now() > deadline) throw new Error('Onshape took too long to export the drawing PDF.');
    await new Promise((r) => setTimeout(r, 1000));
    info = await onshapeFetch(req, `/translations/${started.id}`);
  }
  if (info.requestState !== 'DONE' || !(info.resultExternalDataIds || []).length) {
    throw new Error(`Onshape couldn't export the drawing PDF${info.failureReason ? `: ${info.failureReason}` : '.'}`);
  }
  return onshapeFetch(req, `/documents/d/${ctx.documentId}/externaldata/${info.resultExternalDataIds[0]}`, { raw: true });
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
  const fileBase = safeFileName(b.partNumber);
  if (!lunaPartId) return res.status(400).json({ error: 'Invalid LUNA part.' });
  if (!/^[\x21-\x7E]{1,128}$/.test(partId) || (faceId && !/^[\x21-\x7E]{1,128}$/.test(faceId))) {
    return res.status(400).json({ error: 'Click the part in Onshape first.' });
  }
  if (drawingId && !ONSHAPE_ID.test(drawingId)) return res.status(400).json({ error: 'Invalid drawing.' });

  const files = [];
  const notes = [];

  const [dxf, pdf] = await Promise.allSettled([
    buildDxf(req, dwe, partId, faceId),
    drawingId ? exportDrawingPdf(req, ctx, drawingId, `${fileBase} drawing`) : Promise.resolve(null),
  ]);

  if (dxf.status === 'fulfilled') {
    files.push({ name: `${fileBase}.dxf`, type: 'application/dxf', data: dxf.value.dxf });
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
  console.log(`Parts Tracker Bridge listening on port ${PORT}`);
});
