// Filling a drawing's title block: the part's own Part number, Title 1 and
// Description properties, and the drawing tab's Part number.

const { onshapeFetch } = require('./api');

// Onshape's title block shows the drawn part's own properties (Part number,
// Title 1, Description), and the team keeps its number in the part's name
// instead, so those boxes came out as "----". Before a drawing of a part
// from this document is made, its properties are filled from the card.
// Two calls: read the properties, then write the ones that differ.
const TITLE_PROPS = [['Part number', 'number'], ['Title 1', 'name'], ['Description', 'name']];
async function fillPartProperties(req, source, partId, values) {
  const query = source.configuration && source.configuration !== 'default'
    ? `?configuration=${encodeURIComponent(source.configuration)}` : '';
  const path = `/metadata/${source.dwe}/p/${encodeURIComponent(partId)}${query}`;
  const meta = await onshapeFetch(req, path);
  const props = meta.properties || [];
  const changes = [];
  for (const [propName, key] of TITLE_PROPS) {
    const value = values[key];
    const prop = props.find((p) => String(p.name || '').toLowerCase() === propName.toLowerCase() && p.editable !== false);
    if (!value || !prop || String(prop.value || '') === value) continue;
    // Leave a Description someone typed in Onshape alone.
    if (propName === 'Description' && prop.value) continue;
    changes.push({ propertyId: prop.propertyId, value });
  }
  if (!changes.length) return [];
  await onshapeFetch(req, path, {
    method: 'POST',
    body: JSON.stringify({ jsonType: 'metadata-part', partId, properties: changes }),
  });
  return changes;
}

// The title block's drawing number box (next to the sheet size) reads the
// drawing tab's own Part number, not the part's, so that's set too. The
// drawing tab's own Title 1 gets the name typed in the bridge as well, so the
// name box can be filled even for a part linked from another document (FRC
// Design App spacers and shafts), whose own properties can't be changed.
// A brand-new drawing's boxes are always empty, and these properties have the
// same IDs on every drawing, so after the first lookup a new drawing costs
// 1 call instead of 2.
let drawingPropIds = null; // { number, title }
async function fillDrawingNumber(req, ctx, drawingEid, number, { isNew = false, name = '' } = {}) {
  if (!number) return;
  const path = `/metadata/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${drawingEid}`;
  let ids = isNew ? drawingPropIds : null;
  let current = null;
  if (!ids) {
    const meta = await onshapeFetch(req, path);
    const props = meta.properties || [];
    const find = (propName) => props.find((p) => String(p.name || '').toLowerCase() === propName && p.editable !== false);
    const numberProp = find('part number');
    if (!numberProp) throw new Error('Onshape didn\'t list a Part number property for the drawing');
    const titleProp = find('title 1');
    ids = { number: numberProp.propertyId, title: titleProp ? titleProp.propertyId : null };
    drawingPropIds = ids;
    current = { number: String(numberProp.value || ''), title: titleProp ? String(titleProp.value || '') : '' };
  }
  const properties = [];
  if (!current || current.number !== number) properties.push({ propertyId: ids.number, value: number });
  if (name && ids.title && (!current || current.title !== name)) properties.push({ propertyId: ids.title, value: name });
  if (!properties.length) return;
  try {
    await onshapeFetch(req, path, { method: 'POST', body: JSON.stringify({ properties }) });
  } catch (err) {
    if (err.status === 400 || err.status === 404) drawingPropIds = null;
    throw err;
  }
}

// RENUMBER for a part that got the wrong number: the drawing tab is renamed
// ("26OE-001 Drawing 1" -> "26O-E037 Drawing 1") and its number box set,
// in one write after reading the tab's properties (2 calls).
async function renumberDrawing(req, ctx, drawingEid, number) {
  const path = `/metadata/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${drawingEid}`;
  const meta = await onshapeFetch(req, path);
  const props = meta.properties || [];
  const find = (propName) => props.find((p) => String(p.name || '').toLowerCase() === propName && p.editable !== false);
  const nameProp = find('name');
  const numberProp = find('part number');
  const oldName = nameProp ? String(nameProp.value || '') : '';
  // Keep the "Drawing N" ending; whatever came before it (an old number,
  // or a catalog name like "Shaft") becomes the new number.
  const ending = oldName.match(/\bDrawing\s+\d+\s*$/i);
  const newName = `${number} ${ending ? ending[0].trim() : 'Drawing 1'}`;
  const properties = [];
  if (nameProp && oldName !== newName) properties.push({ propertyId: nameProp.propertyId, value: newName });
  if (numberProp && String(numberProp.value || '') !== number) properties.push({ propertyId: numberProp.propertyId, value: number });
  if (properties.length) await onshapeFetch(req, path, { method: 'POST', body: JSON.stringify({ properties }) });
  return { name: nameProp ? newName : oldName, renamed: Boolean(nameProp), numbered: Boolean(numberProp) };
}

// Title blocks already filled by this server (until it restarts), so asking
// for a part's drawing again (a batch re-run, a reload) doesn't read and
// rewrite the same properties every time: that was up to 4 calls each.
const filledTitleBlocks = new Set();

async function fillTitleBlock(req, ctx, { local, source, partId, drawingEid, partNumber, partName }) {
  const warnings = [];
  const key = [drawingEid, source.dwe, source.configuration || '', partId, partNumber, partName].join('|');
  if (filledTitleBlocks.has(key)) return warnings;
  if (local) {
    try {
      await fillPartProperties(req, source, partId, { number: partNumber, name: partName });
    } catch (err) {
      console.error('Filling part properties failed:', err.message);
      warnings.push(`Couldn't fill the title block's title from the part (${err.status || err.message}).`);
    }
  }
  try {
    await fillDrawingNumber(req, ctx, drawingEid, partNumber, { name: partName });
  } catch (err) {
    console.error('Filling the drawing number failed:', err.message);
    warnings.push(`Couldn't fill the title block's drawing number (${err.status || err.message}).`);
  }
  if (!warnings.length) {
    if (filledTitleBlocks.size > 5000) filledTitleBlocks.clear();
    filledTitleBlocks.add(key);
  }
  return warnings;
}

module.exports = { fillPartProperties, fillDrawingNumber, filledTitleBlocks, fillTitleBlock, renumberDrawing };
