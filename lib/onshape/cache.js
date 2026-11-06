// Reading a Part Studio or document from Onshape, cached by document version
// so the same thing is never asked for twice while the document is unchanged.

const { onshapeFetch } = require('./api');

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
// Which documents Onshape has confirmed each login can open is kept in the
// login itself (req.session.verifiedDocs), so it's saved wherever sessions
// are: Render Key Value when REDIS_URL is set, otherwise memory.
const MAX_VERIFIED_DOCS = 50;
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
    markVerified(req, docKey);
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
  return (req.session.verifiedDocs || []).includes(docKey);
}

function markVerified(req, docKey) {
  const docs = req.session.verifiedDocs || [];
  if (docs.includes(docKey)) return;
  // Oldest first; a login rarely opens more than a few documents.
  req.session.verifiedDocs = [...docs, docKey].slice(-MAX_VERIFIED_DOCS);
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
// After the panel makes a drawing, its saved tab list (plus that drawing) is
// trusted for the next drawing's duplicate check for this long.
const RECENT_DRAWING_MS = 2 * 60 * 1000;
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

module.exports = {
  FRESH_MS,
  RECENT_DRAWING_MS,
  elementLists,
  docKeyOf,
  docVersion,
  isFrozenSource,
  canReuse,
  cachedForSource,
  asSource,
  sourceQuery,
  sourceKey,
  getPartsList,
  getBodyDetails,
  getPartIndex,
  getPartsById,
  getPartIndexWith,
  partIdFor,
  currentDwe,
  elementType,
  getElements,
};
