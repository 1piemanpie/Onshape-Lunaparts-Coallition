// The panel's LUNA Parts routes: dropdown lists, part numbers already used,
// creating parts, renumbering them, and uploading their files.

const express = require('express');
const { onshapeErrorMessage } = require('../lib/onshape/api');
const {
  isLocalSource, ONSHAPE_TAG, linkedPartKey, getAssemblyParts, resolvePart, partShape, onshapeUserName,
} = require('../lib/onshape/parts');
const { safeFileName, buildDxf, exportStep, exportDrawingPdf } = require('../lib/onshape/exports');
const {
  lunaRequest, lunaGetAll, attachmentExtension, getOptions, getStatuses, getParts, getProjectParts,
  drawingStatus, forgetDrawingInfo,
} = require('../lib/luna');
const { REAM_UNDERSIZE_IN } = require('../lib/dxf');
const { requireLogin, requirePanel, requireLunaKey, validate } = require('../lib/middleware');
const schemas = require('../lib/schemas');

const router = express.Router();

// LUNA's external_ref for a part linked from another Onshape document.
const EXTERNAL_REF = /^onshape:(\S{1,392})$/;

// Read-only: fetches the lists the panel needs for its dropdowns. Requires
// an Onshape login so the team's project list isn't public on this URL.
router.get('/api/luna/options', requireLogin, requireLunaKey, async (req, res) => {
  try {
    const { projects, tools, thicknesses } = await getOptions();
    res.json({ projects, tools, thicknesses });
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

// Names compared loosely: case, spacing, and curly or HTML-escaped quotes
// (0.5" can come back as 0.5&quot; or 0.5″) don't count.
function normName(name) {
  return String(name || '')
    .replace(/&quot;|&#0*34;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/[\u201C\u201D\u2033]/g, '"').replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// Read-only: every part number already in LUNA, so the panel can fold away
// parts that have been uploaded.
router.get('/api/luna/part-numbers', requireLogin, async (req, res) => {
  try {
    const parts = await getParts();
    const linked = {};
    // external_ref first; the notes tag only for parts made before it existed.
    for (const p of parts) {
      const m = String(p.external_ref || '').match(EXTERNAL_REF);
      const number = String(p.part_number || '').trim();
      if (m && number && !linked[m[1]]) linked[m[1]] = number;
    }
    for (const p of parts) {
      const m = String(p.notes || '').match(ONSHAPE_TAG);
      const number = String(p.part_number || '').trim();
      if (m && number && !linked[m[1]]) linked[m[1]] = number;
    }
    // LUNA parts by name, for linked parts whose key doesn't match (a row
    // of same-shape copies can be shown by a different copy after a reload)
    // or that were uploaded without their link at all. The panel picks among
    // them (its own project first, linked ones first) and only uses a name
    // that points at one number.
    const byName = {};
    for (const p of parts) {
      const name = normName(p.name);
      const number = String(p.part_number || '').trim();
      if (!name || !number) continue;
      const tagged = EXTERNAL_REF.test(String(p.external_ref || '')) || ONSHAPE_TAG.test(String(p.notes || ''));
      const list = byName[name] || (byName[name] = []);
      if (list.length < 20) list.push({ number, projectId: p.project_id, tagged });
    }
    res.json({
      partNumbers: [...new Set(parts.map((p) => String(p.part_number || '').trim()).filter(Boolean))],
      linked,
      byName,
    });
  } catch (err) {
    console.error('LUNA Parts part-number list failed:', err);
    res.status(502).json({ error: 'Could not read part numbers from LUNA Parts.' });
  }
});

// Team rule: a part whose machine is CNC (or mill/router, but not a lathe) needs a DXF.
const isCncTool = (name) => /cnc|mill|router/i.test(name || '') && !/lathe/i.test(name || '');

// For UPDATE FILES on a part that's already in LUNA: its LUNA id, the next
// revision number, and which kinds of files it has, so the same kinds are
// sent again. LUNA calls only (no Onshape calls).
router.get('/api/luna/part-files', requireLogin, validate('query', schemas.partFilesQuery), async (req, res) => {
  const { number } = req.input;
  try {
    const parts = await getParts();
    const part = parts.find((p) => String(p.part_number || '').trim().toUpperCase() === number);
    if (!part) return res.status(404).json({ error: `${number} isn't in LUNA Parts.` });
    const [files, { tools }] = await Promise.all([lunaGetAll(`parts/${part.id}/attachments`), getOptions()]);
    const tool = (tools || []).find((t) => t.id === part.tool_id);
    const highest = files.reduce((n, f) => Math.max(n, Number(f.revision) || 1), 0);
    // The newest drawing PDF's file name, so UPDATE ALL can tell whether it
    // still carries an old number (26OE-007 drawing.pdf on 26O-E040).
    const pdfs = files.filter((f) => attachmentExtension(f) === 'pdf')
      .sort((a, b) => (Number(b.revision) || 1) - (Number(a.revision) || 1) || Number(Boolean(b.is_drawing)) - Number(Boolean(a.is_drawing)));
    const drawingFile = pdfs.length ? String(pdfs[0].original_filename || pdfs[0].filename || pdfs[0].name || '') : '';
    res.json({
      lunaPartId: part.id,
      projectId: part.project_id,
      drawingFile,
      nextRevision: highest + 1,
      hadDxf: files.some((f) => attachmentExtension(f) === 'dxf'),
      hadStep: files.some((f) => ['step', 'stp'].includes(attachmentExtension(f))),
      // The machine set in LUNA is CNC, so the part must have a DXF.
      cncTool: Boolean(tool && isCncTool(tool.name)),
    });
  } catch (err) {
    console.error('LUNA Parts file lookup failed:', err);
    res.status(502).json({ error: 'Could not read the part from LUNA Parts.' });
  }
});

// Which parts in LUNA have no drawing, checked when the panel opens. It looks
// at every part in the projects this document's parts are in (plus the
// chosen project), so parts that aren't in the open assembly show up too.
// LUNA calls only (one attachments list per part, kept 10 minutes), no
// Onshape calls. Bought parts and assemblies are left out.
router.post('/api/luna/drawing-check', requireLogin, validate('body', schemas.drawingCheckBody), async (req, res) => {
  const { numbers, projectId, only } = req.input;
  try {
    const lunaParts = await getParts();
    const wanted = new Set(numbers);
    const mine = lunaParts.filter((p) => wanted.has(String(p.part_number || '').trim().toUpperCase()));
    let checked;
    if (only) {
      checked = mine;
    } else {
      const projectIds = new Set(mine.map((p) => p.project_id));
      if (projectId) projectIds.add(projectId);
      checked = lunaParts.filter((p) => projectIds.has(p.project_id));
    }
    const { projects } = await getOptions().catch(() => ({ projects: [] }));
    const projectName = new Map((projects || []).map((p) => [p.id, p.name]));
    const parts = (await drawingStatus(checked)).map((p) => ({ ...p, projectName: projectName.get(p.projectId) || '' }));
    res.json({ parts });
  } catch (err) {
    console.error('LUNA Parts drawing check failed:', err);
    res.status(502).json({ error: 'Could not check LUNA Parts for drawings.' });
  }
});

// FIND MISSING DXFs: for parts already in LUNA, which ones should have a DXF
// (auto-detect says plate, or box tube with holes to mill) but have none.
// Onshape cost: bodydetails once per Part Studio (shared with everything
// else, cached by document version), 0 per part. LUNA cost: the parts and
// tools lists once, plus one attachments list per part.
const NO_DXF_TOOLS = /lathe|saw|print|3d/i;
router.post('/api/luna/dxf-check', requireLogin, requirePanel, validate('body', schemas.dxfCheckBody), async (req, res) => {
  const asked = req.input.parts;
  try {
    const [lunaParts, tools] = await Promise.all([getParts(), lunaGetAll('tools')]);
    const byNumber = new Map(lunaParts.map((p) => [String(p.part_number || '').trim().toUpperCase(), p]));
    const toolName = new Map(tools.map((t) => [t.id, String(t.name || '')]));
    const results = [];
    let next = 0;
    const worker = async () => {
      while (next < asked.length) {
        const ask = asked[next++];
        const { number } = ask;
        const out = { partId: ask.partId, number, missing: false, why: '' };
        results.push(out);
        try {
          const lunaPart = byNumber.get(number);
          if (!lunaPart) { out.why = 'Not found in LUNA.'; continue; }
          const shape = await partShape(req, out.partId);
          const d = shape.detect;
          const tool = toolName.get(lunaPart.tool_id) || '';
          let needs = false;
          if (d && d.type === 'tube' && d.needsDxf) {
            needs = true;
            out.why = `box tube with holes to mill (${d.dxfSides.map((x) => x.side).join(' + ')} side)`;
          } else if (d && d.type === 'plate' && !NO_DXF_TOOLS.test(tool)) {
            needs = true;
            out.why = d.pockets ? 'pocketed plate' : 'plate';
          } else if (isCncTool(tool)) {
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
router.post('/api/luna/parts/:id/number', requireLogin,
  validate('params', schemas.lunaIdParams), validate('body', schemas.renumberBody), async (req, res) => {
  const { id, partNumber: number, onshapePartId } = req.input;
  try {
    const got = await lunaRequest(`parts/${id}`);
    if (!got.ok) return res.status(502).json({ error: `LUNA Parts couldn't find that part (${got.status}).` });
    const gotBody = await got.json();
    const part = gotBody.data || gotBody;
    const siblings = await getProjectParts(part.project_id);
    const clash = siblings.find((p) => p.id !== part.id && p.project_id === part.project_id
      && String(p.part_number || '').trim().toUpperCase() === number.toUpperCase());
    if (clash) return res.status(409).json({ error: `${clash.part_number} already exists in this project ("${clash.name}"), so ${part.part_number} wasn't renamed.` });
    const fields = { part_number: number };
    for (const key of ['name', 'description', 'external_ref', 'parent_part_id', 'part_status_id', 'tool_id', 'type', 'material',
      'material_thickness_id', 'priority', 'notes', 'quantity', 'cut_length', 'lead_time_days']) {
      if (part[key] !== null && part[key] !== undefined) fields[key] = part[key];
    }
    // A linked part that was uploaded without its link gets it now, so the
    // panel finds it by its key from then on (not just by name).
    if (!fields.external_ref && onshapePartId && /^a[0-9a-f]{12}$/.test(onshapePartId) && req.session.onshapeContext) {
      try {
        const list = await getAssemblyParts(req, { reuse: true });
        const linkedPart = list.byId.get(onshapePartId);
        const ctx = req.session.onshapeContext;
        const key = linkedPart && !isLocalSource(ctx, linkedPart.source) && linkedPartKey(ctx, linkedPart.source, linkedPart.partId);
        if (key && `onshape:${key}`.length <= 400) fields.external_ref = `onshape:${key}`;
      } catch (err) {
        console.error('Linked part lookup for renumber failed:', err.message);
      }
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
router.get('/api/luna/assemblies', requireLogin, validate('query', schemas.projectQuery), async (req, res) => {
  const projectId = req.input.project_id;
  try {
    const parts = await getProjectParts(projectId);
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

// Creates the part in LUNA Parts. This writes to the team's real tracker,
// so it refuses to create a second part with the same part number in the
// same project (updating an existing part is a separate, later step).
router.post('/api/luna/parts', requireLogin, validate('body', schemas.createPartBody), async (req, res) => {
  const b = req.input;
  const fields = {
    project_id: b.projectId,
    name: b.name,
    part_number: b.partNumber,
    part_status_id: b.statusId,
    type: b.type,
    quantity: b.quantity,
    tool_id: b.toolId,
    priority: b.priority,
    parent_part_id: b.parentPartId,
    material: b.material,
    material_thickness_id: b.thicknessId,
    cut_length: b.cutLength,
    lead_time_days: b.leadTimeDays,
    description: b.description,
  };

  // Everyone uploads through the panel's one LUNA key, so the notes say
  // which Onshape user made the part.
  const who = await onshapeUserName(req);
  const notes = who ? [`Uploaded by ${who} (Onshape, via Luna Parts Bridge)`] : [];

  // A linked assembly part gets LUNA's external_ref ("onshape:<key>"), which
  // ties its LUNA number to it. (Parts made before LUNA had external_ref
  // carry the same key as an [onshape:...] tag in their notes instead.)
  const panelPartId = b.onshapePartId;
  if (/^a[0-9a-f]{12}$/.test(panelPartId) && req.session.onshapeContext) {
    try {
      const list = await getAssemblyParts(req, { reuse: true });
      const part = list.byId.get(panelPartId);
      const ctx = req.session.onshapeContext;
      const key = part && !isLocalSource(ctx, part.source) && linkedPartKey(ctx, part.source, part.partId);
      if (key) {
        const ref = `onshape:${key}`;
        // LUNA allows 400 characters; a key that long (only with a very long
        // configuration) falls back to the old notes tag.
        if (ref.length <= 400) fields.external_ref = ref;
        else notes.push(`[onshape:${key}]`);
      }
    } catch (err) {
      console.error('Linked part lookup failed:', err.message);
    }
  }

  if (notes.length) fields.notes = notes.join('\n');

  try {
    if (fields.part_number) {
      const existing = await getProjectParts(fields.project_id);
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

router.post('/api/luna/parts/:id/attachments', requirePanel,
  validate('params', schemas.lunaIdParams), validate('body', schemas.attachmentsBody), async (req, res) => {
  const ctx = req.session.onshapeContext;
  const {
    id: lunaPartId, partId, faceId, drawingId, wantDxf, wantStep, revision, dxfSides,
  } = req.input;
  const fileBase = safeFileName(req.input.partNumber);
  // A face the user picked wins over the auto-detected tube sides.

  const files = [];
  const notes = [];
  // Set when a DXF was wanted (a CNC part) but couldn't be made, so the panel
  // can flag the part instead of calling the upload a success.
  let dxfMissing = false;

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
    dxfMissing = true;
    notes.push(dxf.reason.status ? 'Couldn\'t read the part from Onshape for the DXF.' : dxf.reason.message);
  }
  if (!drawingId) {
    notes.push('No drawing was chosen, so no PDF was attached.');
  } else if (pdf.status === 'fulfilled') {
    files.push({ name: `${fileBase} drawing.pdf`, type: 'application/pdf', data: pdf.value, drawing: true });
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

  if (!files.length) return res.status(502).json({ error: 'Nothing was attached.', notes, dxfMissing });

  // The drawing PDF goes up on its own with is_drawing, so LUNA lists it as
  // the part's drawing (and puts it in the project's design pack). LUNA
  // marks a whole upload at once, so the other files go in a second request.
  const groups = [
    { files: files.filter((f) => !f.drawing), isDrawing: false },
    { files: files.filter((f) => f.drawing), isDrawing: true },
  ].filter((g) => g.files.length);
  const attached = [];

  for (const group of groups) {
    try {
      const form = new FormData();
      for (const f of group.files) form.append('files[]', new Blob([f.data], { type: f.type }), f.name);
      if (group.isDrawing) form.append('is_drawing', '1');
      if (revision && revision > 1) {
        form.append('revision', String(revision));
        form.append('description', 'Updated from Onshape');
      }

      const lunaRes = await lunaRequest(`parts/${lunaPartId}/attachments`, { method: 'POST', body: form });
      forgetDrawingInfo(lunaPartId);
      if (!lunaRes.ok) {
        const body = await lunaRes.json().catch(() => ({}));
        console.error('LUNA Parts attachment upload failed:', lunaRes.status, body);
        const details = lunaRes.status === 422 ? Object.values(body.errors || {}).flat().join(' ') : '';
        const problem = details || `LUNA Parts didn't accept the files (${lunaRes.status}).`;
        return res.status(502).json({
          error: attached.length ? `${attached.join(' + ')} went up, but ${group.files.map((f) => f.name).join(' + ')} didn't: ${problem}` : problem,
          attached,
          notes,
          dxfMissing,
        });
      }
      attached.push(...group.files.map((f) => f.name));
    } catch (err) {
      console.error('LUNA Parts attachment upload failed:', err);
      const problem = 'Could not reach LUNA Parts to upload the files.';
      return res.status(502).json({ error: attached.length ? `${attached.join(' + ')} went up, but ${group.files.map((f) => f.name).join(' + ')} didn't: ${problem}` : problem, attached, notes, dxfMissing });
    }
  }
  res.json({ attached, notes, dxfMissing });
});

module.exports = router;
