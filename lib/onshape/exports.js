// Files for LUNA Parts: DXFs built from the part's shape, and STEP and
// drawing PDF exports through Onshape's translation service.

const { onshapeFetch } = require('./api');
const { FRESH_MS, isFrozenSource, asSource, sourceQuery, getBodyDetails } = require('./cache');
const { faceToDxf, edgesNeedingPoints, pickFace } = require('../dxf');
const { detectPart } = require('../detect');

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

  // Pocketed plate: draw from the flat back side and put each pocket floor
  // on its own layer, so the CAM software can pocket them.
  let layers = [];
  try {
    const d = detectPart(body);
    if (d && d.type === 'plate' && d.pockets && (!faceId || faceId === d.dxfFaceId)) {
      if (!faceId) faceId = d.dxfFaceId;
      layers = d.pocketLayers || [];
    }
  } catch (err) {
    console.error('Pocket check for DXF failed:', err.message);
  }

  // Splines and other curves need their tessellated points from Onshape.
  const { face } = pickFace(body, faceId);
  const edgePoints = new Map();
  const extra = face ? edgesNeedingPoints(body, face, layers.map((l) => l.faceId)) : [];
  if (extra.length) {
    const query = new URLSearchParams({ partId });
    for (const id of extra) query.append('edgeId', id);
    const tess = await onshapeFetch(req, `/partstudios/${source.dwe}/tessellatededges${sourceQuery(source, query)}`);
    for (const b of tess.bodies || []) {
      for (const e of b.edges || []) edgePoints.set(e.id, e.vertices || []);
    }
  }
  return faceToDxf(body, faceId, edgePoints, layers);
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

module.exports = { safeFileName, buildDxf, runTranslation, exportStep, exportDrawingPdf };
