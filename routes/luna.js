// The panel's LUNA Parts routes: dropdown lists, part numbers already used,
// creating parts, renumbering them, and uploading their files.

const express = require('express');
const { ONSHAPE_ID, onshapeErrorMessage } = require('../lib/onshape/api');
const {
  isLocalSource, ONSHAPE_TAG, linkedPartKey, getAssemblyParts, resolvePart, partShape, onshapeUserName,
} = require('../lib/onshape/parts');
const { safeFileName, buildDxf, exportStep, exportDrawingPdf } = require('../lib/onshape/exports');
const { lunaRequest, lunaGetAll, attachmentExtension, getStatuses } = require('../lib/luna');
const { REAM_UNDERSIZE_IN } = require('../lib/dxf');
const { requireLogin, requirePanel, requireLunaKey } = require('../lib/middleware');

const router = express.Router();

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

// Read-only: fetches the lists the panel needs for its dropdowns. Requires
// an Onshape login so the team's project list isn't public on this URL.
router.get('/api/luna/options', requireLogin, requireLunaKey, async (req, res) => {
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
router.get('/api/luna/part-numbers', requireLogin, async (req, res) => {
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

// For UPDATE FILES on a part that's already in LUNA: its LUNA id, the next
// revision number, and which kinds of files it has, so the same kinds are
// sent again. LUNA calls only (no Onshape calls).
router.get('/api/luna/part-files', requireLogin, async (req, res) => {
  const number = String(req.query.number || '').trim().toUpperCase();
  if (!number || number.length > 80) return res.status(400).json({ error: 'Which part?' });
  try {
    const parts = await lunaGetAll('parts');
    const part = parts.find((p) => String(p.part_number || '').trim().toUpperCase() === number);
    if (!part) return res.status(404).json({ error: `${number} isn't in LUNA Parts.` });
    const files = await lunaGetAll(`parts/${part.id}/attachments`);
    const highest = files.reduce((n, f) => Math.max(n, Number(f.revision) || 1), 0);
    res.json({
      lunaPartId: part.id,
      nextRevision: highest + 1,
      hadDxf: files.some((f) => attachmentExtension(f) === 'dxf'),
      hadStep: files.some((f) => ['step', 'stp'].includes(attachmentExtension(f))),
    });
  } catch (err) {
    console.error('LUNA Parts file lookup failed:', err);
    res.status(502).json({ error: 'Could not read the part from LUNA Parts.' });
  }
});

// FIND MISSING DXFs: for parts already in LUNA, which ones should have a DXF
// (auto-detect says plate, or box tube with holes to mill) but have none.
// Onshape cost: bodydetails once per Part Studio (shared with everything
// else, cached by document version), 0 per part. LUNA cost: the parts and
// tools lists once, plus one attachments list per part.
const NO_DXF_TOOLS = /lathe|saw|print|3d/i;
router.post('/api/luna/dxf-check', requireLogin, requirePanel, async (req, res) => {
  const asked = (Array.isArray((req.body || {}).parts) ? req.body.parts : [])
    .filter((p) => p && /^[\x21-\x7E]{1,128}$/.test(String(p.partId || '')) && String(p.number || '').trim())
    .slice(0, 200);
  try {
    const [lunaParts, tools] = await Promise.all([lunaGetAll('parts'), lunaGetAll('tools')]);
    const byNumber = new Map(lunaParts.map((p) => [String(p.part_number || '').trim().toUpperCase(), p]));
    const toolName = new Map(tools.map((t) => [t.id, String(t.name || '')]));
    const results = [];
    let next = 0;
    const worker = async () => {
      while (next < asked.length) {
        const ask = asked[next++];
        const number = String(ask.number).trim().toUpperCase();
        const out = { partId: String(ask.partId), number, missing: false, why: '' };
        results.push(out);
        try {
          const lunaPart = byNumber.get(number);
          if (!lunaPart) { out.why = 'Not found in LUNA.'; continue; }
          const shape = await partShape(req, out.partId);
          const d = shape.detect;
          const tool = toolName.get(lunaPart.tool_id) || '';
          let needs = false;
          if (d && d.type === 'tube') {
            needs = d.needsDxf;
            out.why = d.needsDxf ? `box tube with holes to mill (${d.dxfSides.map((x) => x.side).join(' + ')} side)` : '';
          } else if (d && d.type === 'plate') {
            needs = !NO_DXF_TOOLS.test(tool);
            out.why = needs ? (d.pockets ? 'pocketed plate' : 'plate') : '';
          } else if (/cnc|mill|router/i.test(tool) && !/lathe/i.test(tool)) {
            needs = true;
            out.why = `machine in LUNA is ${tool}`;
          }
          if (!needs) continue;
          const files = await lunaGetAll(`parts/${lunaPart.id}/attachments`);
          out.missing = !files.some((f) => attachmentExtension(f) === 'dxf');
        } catch (err) {
          if (err.status === 402) throw err;
          out.why = err.message;
        }
      }
    };
    await Promise.all([1, 2, 3, 4].map(worker));
    res.json({ results });
  } catch (err) {
    console.error('DXF check failed:', err);
    res.status(502).json({ error: err.status === 402 ? onshapeErrorMessage(err) : 'Could not check the parts in LUNA Parts.' });
  }
});

// UPDATE FILES on a part renamed in Onshape after upload (E018 -> 26O-E018):
// gives the LUNA part the new number too. LUNA's edit needs the required
// fields sent back, so the part is read first.
router.post('/api/luna/parts/:id/number', requireLogin, async (req, res) => {
  const id = optionalNumber(req.params.id, { integer: true });
  const number = String((req.body || {}).partNumber || '').trim();
  if (!id) return res.status(400).json({ error: 'Invalid LUNA part.' });
  if (!number || number.length > 80) return res.status(400).json({ error: 'Give the part a number first.' });
  try {
    const got = await lunaRequest(`parts/${id}`);
    if (!got.ok) return res.status(502).json({ error: `LUNA Parts couldn't find that part (${got.status}).` });
    const gotBody = await got.json();
    const part = gotBody.data || gotBody;
    const siblings = await lunaGetAll(`parts?project_id=${part.project_id}`);
    const clash = siblings.find((p) => p.id !== part.id && p.project_id === part.project_id
      && String(p.part_number || '').trim().toUpperCase() === number.toUpperCase());
    if (clash) return res.status(409).json({ error: `${clash.part_number} already exists in this project ("${clash.name}"), so ${part.part_number} wasn't renamed.` });
    const fields = { part_number: number };
    for (const key of ['name', 'description', 'parent_part_id', 'part_status_id', 'tool_id', 'type', 'material',
      'material_thickness_id', 'priority', 'notes', 'quantity', 'cut_length', 'lead_time_days']) {
      if (part[key] !== null && part[key] !== undefined) fields[key] = part[key];
    }
    if (!fields.part_status_id && part.status && part.status.id) fields.part_status_id = part.status.id;
    const put = await lunaRequest(`parts/${id}`, { method: 'PUT', json: fields });
    if (!put.ok) {
      console.error('LUNA Parts rename failed:', put.status, await put.text());
      return res.status(502).json({ error: `LUNA Parts didn't accept the new number (${put.status}).` });
    }
    res.json({ ok: true, partNumber: number });
  } catch (err) {
    console.error('LUNA Parts rename failed:', err);
    res.status(502).json({ error: 'Could not reach LUNA Parts to rename the part.' });
  }
});

// Read-only: assemblies in one project, for the "Parent Assembly" dropdown.
// The API mentions a project_id filter without documenting it, so we pass
// it and also filter here in case it's ignored.
router.get('/api/luna/assemblies', requireLogin, async (req, res) => {
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

router.get('/api/luna/statuses', requireLogin, async (req, res) => {

  try {
    res.json({ statuses: await getStatuses() });
  } catch (err) {
    console.error('LUNA Parts status lookup failed:', err);
    res.status(502).json({ error: 'Could not load part statuses from LUNA Parts.' });
  }
});

router.post('/api/luna/parts', requireLogin, async (req, res) => {

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

    const lunaRes = await lunaRequest('parts', { method: 'POST', body: form });
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

router.post('/api/luna/parts/:id/attachments', requirePanel, async (req, res) => {
  const ctx = req.session.onshapeContext;

  const lunaPartId = optionalNumber(req.params.id, { integer: true });
  const b = req.body || {};
  const partId = String(b.partId || '');
  const faceId = b.faceId ? String(b.faceId) : null;
  const drawingId = b.drawingId ? String(b.drawingId) : null;
  // DXFs are only for parts cut on the CNC; the panel decides from the Machine.
  const wantDxf = b.wantDxf !== false;
  const wantStep = b.wantStep === true;
  // UPDATE FILES sends the files again as the next revision.
  const revision = optionalNumber(b.revision, { integer: true });
  const fileBase = safeFileName(b.partNumber);
  // Box tube with holes to mill: one DXF per side (auto-detect), e.g.
  // "26O-E003 top side.dxf". A face the user picked wins over these.
  const dxfSides = (Array.isArray(b.dxfSides) ? b.dxfSides : [])
    .filter((d) => d && /^[\x21-\x7E]{1,128}$/.test(String(d.faceId || '')) && /^[a-z]{2,10}$/.test(String(d.side || '')))
    .slice(0, 6);
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
    !wantDxf ? Promise.resolve(null)
      : dxfSides.length && !faceId
        ? Promise.all(dxfSides.map(async (d) => ({ ...(await buildDxf(req, resolved.source, resolved.partId, String(d.faceId))), side: d.side })))
        : buildDxf(req, resolved.source, resolved.partId, faceId),
    drawingId ? exportDrawingPdf(req, ctx, drawingId, `${fileBase} drawing`) : Promise.resolve(null),
    wantStep ? exportStep(req, resolved.source, resolved.partId, fileBase) : Promise.resolve(null),
  ]);

  if (!wantDxf) {
    // Not a CNC part: no DXF wanted, so nothing to report.
  } else if (dxf.status === 'fulfilled' && Array.isArray(dxf.value)) {
    for (const d of dxf.value) files.push({ name: `${fileBase} ${d.side} side.dxf`, type: 'application/dxf', data: d.dxf });
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
    if (revision && revision > 1) {
      form.append('revision', String(revision));
      form.append('description', 'Updated from Onshape');
    }

    const lunaRes = await lunaRequest(`parts/${lunaPartId}/attachments`, { method: 'POST', body: form });
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

module.exports = router;
