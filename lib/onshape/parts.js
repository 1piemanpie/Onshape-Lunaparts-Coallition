// Onshape parts: block CAD, assemblies, sorting into groups, sizes, shapes
// and mass properties. Everything here reads through the caches in cache.js.

const crypto = require('crypto');
const { ONSHAPE_ID, onshapeFetch } = require('./api');
const {
  FRESH_MS, docVersion, canReuse, cachedForSource, asSource, sourceQuery, sourceKey,
  getPartsById, getBodyDetails, currentDwe, elementType,
} = require('./cache');
const { detectPart, bodyBox } = require('../detect');

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
// part's external_ref is "onshape:<assembly doc>|<source doc>|<element>|
// <part>|<configuration>", which is how the panel finds the number again.
// Parts made before LUNA had external_ref carry the same key as an
// "[onshape:...]" tag in their notes. The source version is left out so a library update keeps the match.
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
  // A part from this document's own workspace leaves out the microversion:
  // it changes on every edit anywhere in the document (making a drawing too),
  // which used to change the part's id between the list and a later request.
  const partKey = (p) => [p.documentId, p.elementId, p.partId, p.configuration || '',
    p.documentVersion || (p.documentId === ctx.documentId ? '' : p.documentMicroversion) || ''].join('|');
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

// The part's size and what it looks like it is (plate, box tube, shaft),
// with suggestions for the card: Machine, Thickness, Cut Length and which
// DXFs to make (detect.js). Everything comes from the Part Studio's
// bodydetails, which is fetched once per Part Studio and document version
// and shared with DXFs, twins and drawings: 0 extra Onshape calls per part.
// Only if the part can't be found there does it fall back to the part's
// bounding box (1 call, cached).
async function partShape(req, partId) {
  const { source, partId: sourcePartId } = await resolvePart(req, partId);
  let body = null;
  try {
    const details = await getBodyDetails(req, source);
    body = details.bodiesById.get(sourcePartId) || null;
  } catch (err) {
    if (err.status === 402) throw err;
    console.error('bodydetails for part shape failed:', err.message);
  }
  const box = (body && bodyBox(body)) || await partBox(req, source, sourcePartId);
  const dims = [box.highX - box.lowX, box.highY - box.lowY, box.highZ - box.lowZ]
    .map((m) => m / METERS_PER_INCH)
    .sort((a, b) => a - b);
  const [small, mid, long] = dims;
  let shape = 'block';
  if (long >= 3 * mid && mid <= 1.3 * small && mid <= 2.5) shape = 'shaft';
  else if (small <= 0.5 && mid >= 4 * small) shape = 'plate';
  let detect = null;
  try {
    detect = body ? detectPart(body, box) : null;
  } catch (err) {
    console.error('Auto-detect failed:', err.message);
  }
  return { shape, dims: dims.map((d) => Number(d.toFixed(4))), thickness: shape === 'plate' ? Number(small.toFixed(4)) : null, detect };
}

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

// Names a part the same way across edits and versions (the list's own id
// changes whenever the document does), so the panel can remember choices
// like "this is COTS".
function stablePartKey(source, partId) {
  const src = asSource(source);
  const m = String(src.dwe || '').match(/^d\/([^/]+)\/[wvm]\/[^/]+\/e\/([^/]+)/);
  const raw = m ? [m[1], m[2], partId, src.configuration || ''].join('|') : `${src.dwe}|${partId}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
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

module.exports = {
  derivedPartIds,
  withBlockCad,
  ownerViaFeatureScript,
  partGroup,
  isLocalSource,
  ONSHAPE_TAG,
  linkedPartKey,
  getAssemblyParts,
  resolvePart,
  PART_CACHE_MAX_AGE_MS,
  partBox,
  partShape,
  partMassProps,
  sameShape,
  stablePartKey,
  onshapeUserName,
};
