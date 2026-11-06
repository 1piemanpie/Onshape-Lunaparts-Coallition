// What each API route accepts, written as zod schemas. The validate()
// middleware (lib/middleware.js) checks a request against one of these and
// puts the cleaned-up values in req.input.
//
// Each schema comes with `messages`: what the panel is told when a field is
// wrong, in the order the fields are checked. Usually only the first problem
// is shown; creating a LUNA part lists them all (`all: true`).

const { z } = require('zod');
const { ONSHAPE_ID } = require('./onshape/api');

// ---- Building blocks -------------------------------------------------------

// Text from the panel. A missing value (or null, false, 0) counts as empty;
// anything else is turned into a string.
const blank = z.literal([undefined, null, false, 0, '']).transform(() => '');
const text = z.union([blank, z.coerce.string()]).default('');
const trimmed = text.pipe(z.string().trim());

// A whole number that may be left empty (null). Strings like "4" count.
const empty = z.literal([undefined, null, '']).transform(() => null);
const optionalWhole = z.union([empty, z.coerce.number().int().nonnegative()]).default(null);
const optionalAmount = z.union([empty, z.coerce.number().nonnegative()]).default(null);
// A whole number of 1 or more, e.g. a LUNA id.
const positiveWhole = z.coerce.number().int().positive();

// Onshape IDs for parts, faces and 3D selections use a base64-like alphabet
// ("S8O+D", "JH/"), so any visible ASCII is allowed. They're only compared or
// sent in a JSON body, never put in a URL path as they are.
const selectionId = text.pipe(z.string().regex(/^[\x21-\x7E]{1,128}$/));
// Nothing, or a selection ID.
const optionalSelectionId = z.union([blank.transform(() => null), z.coerce.string().pipe(selectionId)]).default(null);

// A part number typed on the card, like 26O-E001.
const partNumber = trimmed.pipe(z.string().min(1).max(80));

// An optional list where bad entries are dropped instead of failing the request.
function listOf(item, max) {
  return z.array(item.catch(null)).catch([])
    .transform((items) => items.filter((x) => x !== null).slice(0, max));
}

// ---- Logging in -------------------------------------------------------------

// The open document's IDs, which Onshape adds to the extension's Action URL.
// Kept only when all three are real Onshape IDs (24 hex characters).
const panelContextQuery = z.object({
  documentId: z.string().regex(ONSHAPE_ID),
  workspaceId: z.string().regex(ONSHAPE_ID),
  elementId: z.string().regex(ONSHAPE_ID),
});

// ---- Onshape routes ----------------------------------------------------------

const partIdQuery = {
  schema: z.object({ partId: selectionId }),
  messages: { partId: 'Invalid part.' },
};

const selectionQuery = {
  schema: z.object({ selectionId }),
  messages: { selectionId: 'Invalid selection.' },
};

const twinsBody = {
  schema: z.object({ partIds: listOf(z.coerce.string().pipe(selectionId), 500) }),
  messages: {},
};

// A prefix like 26O-E.
const NAME_PREFIX = /^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/;
const nextNumberQuery = {
  schema: z.object({
    prefix: text.pipe(z.string().regex(NAME_PREFIX)),
    // Only used when it's a real project ID.
    project_id: positiveWhole.catch(null),
    // Parts about to be renumbered don't hold on to their old numbers.
    exclude: text.transform((s) => s.split(',').filter(Boolean).slice(0, 1000)),
  }),
  messages: { prefix: 'Use letters, numbers and dashes for the prefix, like 26O-E.' },
};

// Characters Onshape part names can use here.
const PART_NAME = /^[\w .\-()#/]{1,80}$/;
const renameBody = {
  schema: z.object({
    partId: selectionId,
    name: trimmed.pipe(z.string().regex(PART_NAME)),
  }),
  messages: {
    partId: 'Invalid part.',
    name: 'That name has characters Onshape parts can\'t use here.',
  },
};

const makeDrawingBody = {
  schema: z.object({
    partId: selectionId,
    partNumber,
    // 1 to 9999; anything unreadable counts as 1.
    quantity: z.coerce.number().catch(1)
      .transform((n) => Math.max(1, Math.min(9999, Math.trunc(n) || 1))),
    material: text.transform((s) => s.slice(0, 80)),
    partName: text.transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, 60)),
    force: z.unknown().optional().transform(Boolean),
  }),
  messages: {
    partId: 'Invalid part.',
    partNumber: 'Give the part a number first.',
  },
};

// ---- LUNA Parts routes -------------------------------------------------------

const lunaIdParams = {
  schema: z.object({ id: positiveWhole }),
  messages: { id: 'Invalid LUNA part.' },
};

const partFilesQuery = {
  schema: z.object({ number: trimmed.pipe(z.string().toUpperCase().min(1).max(80)) }),
  messages: { number: 'Which part?' },
};

const dxfCheckBody = {
  schema: z.object({
    parts: listOf(z.object({
      partId: selectionId,
      number: trimmed.pipe(z.string().toUpperCase().min(1)),
    }), 200),
  }),
  messages: {},
};

const renumberBody = {
  schema: z.object({ partNumber }),
  messages: { partNumber: 'Give the part a number first.' },
};

const projectQuery = {
  schema: z.object({ project_id: positiveWhole }),
  messages: { project_id: 'project_id is required.' },
};

const PART_TYPES = ['part', 'assembly', 'purchased'];
const createPartBody = {
  all: true,
  schema: z.object({
    projectId: positiveWhole,
    name: trimmed.pipe(z.string().min(1)),
    statusId: positiveWhole,
    type: z.enum(PART_TYPES),
    quantity: optionalWhole.pipe(z.number()),
    toolId: optionalWhole,
    priority: optionalWhole,
    parentPartId: optionalWhole,
    thicknessId: optionalWhole,
    cutLength: optionalAmount,
    leadTimeDays: optionalWhole,
    partNumber: trimmed,
    material: trimmed,
    description: trimmed,
    // The panel's ID for a part linked into the assembly (a + 12 hex).
    onshapePartId: text,
  }),
  messages: {
    projectId: 'Choose a project.',
    name: 'Enter a name.',
    statusId: 'Choose a status.',
    type: 'Choose a type.',
    quantity: 'Quantity must be a whole number.',
    toolId: 'tool id isn\'t a valid number.',
    priority: 'priority isn\'t a valid number.',
    parentPartId: 'parent part id isn\'t a valid number.',
    thicknessId: 'material thickness id isn\'t a valid number.',
    cutLength: 'cut length isn\'t a valid number.',
    leadTimeDays: 'lead time days isn\'t a valid number.',
  },
};

const attachmentsBody = {
  schema: z.object({
    partId: selectionId,
    // The face that was clicked, if any: the DXF is made from it.
    faceId: optionalSelectionId,
    drawingId: z.union([blank.transform(() => null), z.coerce.string().regex(ONSHAPE_ID)]).default(null),
    // DXFs are only for parts cut on the CNC; the panel decides from the Machine.
    wantDxf: z.unknown().optional().transform((v) => v !== false),
    wantStep: z.unknown().optional().transform((v) => v === true),
    // UPDATE FILES sends the files again as the next revision.
    revision: optionalWhole.catch(null),
    // Only used for file names (see safeFileName).
    partNumber: z.unknown().optional(),
    // Box tube with holes to mill: one DXF per side (auto-detect), e.g.
    // "26O-E003 top side.dxf".
    dxfSides: listOf(z.object({
      faceId: selectionId,
      side: text.pipe(z.string().regex(/^[a-z]{2,10}$/)),
    }), 6),
  }),
  messages: {
    partId: 'Click the part in Onshape first.',
    faceId: 'Click the part in Onshape first.',
    drawingId: 'Invalid drawing.',
  },
};

module.exports = {
  panelContextQuery,
  partIdQuery,
  selectionQuery,
  twinsBody,
  nextNumberQuery,
  renameBody,
  makeDrawingBody,
  lunaIdParams,
  partFilesQuery,
  dxfCheckBody,
  renumberBody,
  projectQuery,
  createPartBody,
  attachmentsBody,
};
