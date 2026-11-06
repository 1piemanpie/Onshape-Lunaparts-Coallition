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
// drawing tab's own Part number, not the part's, so that's set too.
// A brand-new drawing's number box is always empty, and the Part number
// property has the same ID on every drawing, so after the first lookup a new
// drawing's number costs 1 call instead of 2.
let drawingNumberPropId = null;
async function fillDrawingNumber(req, ctx, drawingEid, number, { isNew = false } = {}) {
  if (!number) return;
  const path = `/metadata/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${drawingEid}`;
  let propertyId = isNew ? drawingNumberPropId : null;
  if (!propertyId) {
    const meta = await onshapeFetch(req, path);
    const prop = (meta.properties || []).find((p) => String(p.name || '').toLowerCase() === 'part number' && p.editable !== false);
    if (!prop) throw new Error('Onshape didn\'t list a Part number property for the drawing');
    drawingNumberPropId = prop.propertyId;
    if (String(prop.value || '') === number) return;
    propertyId = prop.propertyId;
  }
  try {
    await onshapeFetch(req, path, {
      method: 'POST',
      body: JSON.stringify({ properties: [{ propertyId, value: number }] }),
    });
  } catch (err) {
    if (err.status === 400 || err.status === 404) drawingNumberPropId = null;
    throw err;
  }
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
    await fillDrawingNumber(req, ctx, drawingEid, partNumber);
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

module.exports = { fillPartProperties, fillDrawingNumber, filledTitleBlocks, fillTitleBlock };
