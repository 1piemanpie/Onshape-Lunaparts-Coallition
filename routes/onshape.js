// The panel's Onshape routes: parts lists, clicks, shapes, pictures, twins,
// part numbering, and drawings.

const express = require('express');
const { usage, onshapeFetch, API_LIMIT_MESSAGE, onshapeErrorMessage } = require('../lib/onshape/api');
const {
  FRESH_MS, RECENT_DRAWING_MS, elementLists, docKeyOf, sourceQuery, sourceKey,
  getPartsList, getBodyDetails, getPartIndex, getPartsById, getPartIndexWith, partIdFor, elementType, getElements,
} = require('../lib/onshape/cache');
const {
  derivedPartIds, withBlockCad, ownerViaFeatureScript, partGroup, isLocalSource, linkedPartKey,
  getAssemblyParts, resolvePart, PART_CACHE_MAX_AGE_MS, partBox, partShape, partMassProps, sameShape, stablePartKey,
} = require('../lib/onshape/parts');
const { fillPartProperties, fillDrawingNumber, filledTitleBlocks, fillTitleBlock } = require('../lib/onshape/title-block');
const { runTranslation } = require('../lib/onshape/exports');
const { lunaGetAll } = require('../lib/luna');
const { isPlanar } = require('../lib/dxf');
const { compareBodies } = require('../lib/twins');
const { makeDrawing } = require('../lib/drawings');
const { requireLogin, requirePanel, validate } = require('../lib/middleware');
const schemas = require('../lib/schemas');

const router = express.Router();

// How many Onshape calls the server has made since it last started.
router.get('/api/usage', requireLogin, (req, res) => {
  const byAction = Object.entries(usage.byAction).sort((a, b) => b[1] - a[1]);
  res.json({ since: usage.since, total: usage.total, byAction: Object.fromEntries(byAction) });
});

router.get('/api/onshape/part-shape', requirePanel, validate('query', schemas.partIdQuery), async (req, res) => {
  const { partId } = req.input;

  try {
    res.json(await partShape(req, partId));
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
router.get('/api/onshape/part-image', requirePanel, validate('query', schemas.partIdQuery), async (req, res) => {
  const { partId } = req.input;

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

// Twins: parts with the same shape (see partMassProps and twins.js).
router.post('/api/onshape/twins', requirePanel, validate('body', schemas.twinsBody), async (req, res) => {
  const ids = req.input.partIds;

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
router.get('/api/onshape/parts', requirePanel, async (req, res) => {
  const dwe = req.dwe;

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

router.get('/api/onshape/selected-part', requirePanel, validate('query', schemas.selectionQuery), async (req, res) => {
  const dwe = req.dwe;
  const { selectionId } = req.input;

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
// Onshape's "Name" property has the same ID on every part, so it's looked up
// once (one extra call) and then each rename is a single call.
let namePropertyId = null;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The next free number after the highest one already used, in this Part
// Studio or (when a project is picked) in LUNA Parts.
router.get('/api/onshape/next-number', requirePanel, validate('query', schemas.nextNumberQuery), async (req, res) => {
  const dwe = req.dwe;
  const { prefix, project_id: projectId } = req.input;
  // Parts about to be renumbered don't hold on to their old numbers.
  const exclude = new Set(req.input.exclude);

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
  if (projectId) {
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

router.post('/api/onshape/rename', requirePanel, validate('body', schemas.renameBody), async (req, res) => {
  const ctx = req.session.onshapeContext;
  const dwe = req.dwe;
  const { partId, name } = req.input;

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
router.get('/api/onshape/drawings', requirePanel, async (req, res) => {

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

// Drawings being made right now, by document + part number. If the panel
// reloads while a drawing is being made, it asks again; that ask waits for
// the first one instead of making a second drawing.
const drawingsInFlight = new Map();

router.post('/api/onshape/make-drawing', requirePanel, validate('body', schemas.makeDrawingBody), async (req, res) => {
  const ctx = req.session.onshapeContext;
  const { partId, partNumber, quantity: qty, material, partName, force } = req.input;

  const flightKey = `${ctx.documentId}:${partNumber.split(/\s+/)[0].toUpperCase()}`;
  const running = !force && drawingsInFlight.get(flightKey);
  if (running) {
    try {
      const made = await running;
      return res.json({ ...made, existing: true });
    } catch (err) { /* that one failed; try again below */ }
  }
  let finish;
  const flight = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  flight.catch(() => {});
  drawingsInFlight.set(flightKey, flight);

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
    // Drawings this server just made are added to the saved tab list, so a
    // batch doesn't re-read the whole list (2 calls) before every drawing.
    const saved = elementLists.get(docKeyOf(ctx));
    const elements = saved && Date.now() - saved.madeAt < RECENT_DRAWING_MS
      ? await saved.value
      : await getElements(req, { maxAgeMs: 5000 });
    const drawings = elements.filter((e) => e.elementType === 'DRAWING'
      || (e.elementType === 'APPLICATION' && /drawing/i.test(e.dataType || '')));
    const key = partNumber.split(/\s+/)[0].toUpperCase();
    const existing = drawings.find((e) => String(e.name || '').split(/\s+/)[0].toUpperCase() === key);
    if (existing && !force) {
      // The title block reads the part's properties live, so filling them
      // also fixes a drawing made before they were filled.
      const warnings = await fillTitleBlock(req, ctx, {
        local: reference.elementId === eid && !reference.documentId,
        source, partId: sourcePartId, drawingEid: existing.id, partNumber, partName,
      });
      return res.json({ drawingId: existing.id, name: existing.name, existing: true, warnings });
    }
    let n = 1;
    const names = new Set(drawings.map((e) => e.name));
    while (names.has(`${partNumber} Drawing ${n}`)) n += 1;
    const name = `${partNumber} Drawing ${n}`;

    const index = await getPartIndexWith(req, source, sourcePartId);
    const body = index.bodiesById.get(sourcePartId);
    if (!body) return res.status(404).json({ error: 'Couldn\'t read the part\'s shape from Onshape.' });
    const box = await partBox(req, source, sourcePartId);

    // Fill the title block's part number and title (parts from this document
    // only; linked parts can't be changed from here). Done after the shape
    // reads, since any edit makes the document's cached data look stale.
    const local = reference.elementId === eid && !reference.documentId;
    const titleWarnings = [];
    if (local) {
      try {
        await fillPartProperties(req, source, sourcePartId, { number: partNumber, name: partName });
      } catch (err) {
        console.error('Filling part properties failed:', err.message);
        titleWarnings.push(`Couldn't fill the title block's title from the part (${err.status || err.message}).`);
      }
    } else {
      titleWarnings.push('This part is linked from another document, so the title block\'s title stays empty.');
    }

    const result = await makeDrawing({
      api: (path, options) => onshapeFetch(req, path, options),
      ctx,
      reference,
      body,
      box,
      name,
      partNumber,
      partName,
      qty,
      material,
      exportJson: async (drawingEid) => JSON.parse(String(await runTranslation(req,
        `/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${drawingEid}/translations`,
        { formatName: 'DRAWING_JSON', storeInDocument: false, level: 'full' }, ctx.documentId, 'drawing data'))),
    });
    // The document now has a new tab. Add it to the saved list so the next
    // drawing in a batch can check names without asking Onshape again; the
    // Drawing picker still re-reads the list on its next load.
    const list = elementLists.get(docKeyOf(ctx));
    if (list) {
      const tabs = await list.value.catch(() => null);
      if (tabs) {
        tabs.push({ id: result.drawingId, name: result.name, elementType: 'DRAWING' });
        list.madeAt = Date.now();
        list.stamp = 'made-here';
      }
    }
    // The drawing tab exists now, so its own number can be set.
    try {
      await fillDrawingNumber(req, ctx, result.drawingId, partNumber, { isNew: true });
    } catch (err) {
      console.error('Filling the drawing number failed:', err.message);
      titleWarnings.push(`Couldn't fill the title block's drawing number (${err.status || err.message}).`);
    }
    if (!titleWarnings.length) {
      filledTitleBlocks.add([result.drawingId, source.dwe, source.configuration || '', sourcePartId, partNumber, partName].join('|'));
    }
    result.warnings = [...titleWarnings, ...(result.warnings || [])];
    finish.resolve(result);
    res.json(result);
  } catch (err) {
    finish.reject(err);
    console.error('Make drawing failed:', err);
    if (err.status === 403) {
      return res.status(403).json({
        error: 'The app can\'t edit Onshape yet. In the Onshape developer portal, give the app "write to your documents" permission, then click Reconnect to Onshape.',
        needsWrite: true,
      });
    }
    res.status(502).json({ error: err.status === 401 || err.status === 402 ? onshapeErrorMessage(err) : err.status ? `Onshape couldn't make the drawing (${err.status}): ${String(err.message).split(': ').slice(1).join(': ').slice(0, 200)}` : err.message });
  } finally {
    // Early returns (an existing drawing, a bad part) settle it too, so
    // anyone waiting asks again rather than waiting forever.
    finish.reject(new Error('Drawing request ended.'));
    if (drawingsInFlight.get(flightKey) === flight) drawingsInFlight.delete(flightKey);
  }
});

module.exports = router;
