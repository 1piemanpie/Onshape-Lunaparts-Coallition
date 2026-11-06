// Preloaded into the server by test/api.test.js: replaces fetch with fixed
// Onshape and LUNA Parts answers, and logs every outgoing call to MOCK_LOG.
const fs = require('fs');
const LOG = process.env.MOCK_LOG;
const D = 'd'.repeat(24), W = 'a'.repeat(24), E = 'e'.repeat(24), A = 'b'.repeat(24);
const DRW = 'c'.repeat(24), LD = '1'.repeat(24), LV = '2'.repeat(24), LE = '3'.repeat(24);
const IN = 0.0254;

function box(id, x, y, z) {
  const P = [];
  for (const a of [0, x]) for (const b of [0, y]) for (const c of [0, z]) P.push([a, b, c]);
  const vid = (i) => `${id}V${i}`;
  const edges = [];
  const eKey = new Map();
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    const d = P[i].map((v, k) => v !== P[j][k]).filter(Boolean).length;
    if (d === 1) {
      const eid = `${id}E${edges.length}`;
      eKey.set(`${i}-${j}`, eid);
      edges.push({ id: eid, curve: { type: 'line' }, geometry: { startPoint: P[i], endPoint: P[j], length: Math.hypot(...P[i].map((v, k) => v - P[j][k])) }, vertices: [vid(i), vid(j)] });
    }
  }
  const faces = [];
  for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
    const val = side ? [x, y, z][axis] : 0;
    const idx = P.map((p, i) => i).filter((i) => P[i][axis] === val);
    const normal = [0, 0, 0]; normal[axis] = side ? 1 : -1;
    const fe = [];
    for (const [k, eid] of eKey) { const [i, j] = k.split('-').map(Number); if (idx.includes(i) && idx.includes(j)) fe.push(eid); }
    const dims = [x, y, z].filter((_, k) => k !== axis);
    faces.push({ id: `${id}F${faces.length}`, area: dims[0] * dims[1], surface: { type: 'plane', normal, origin: P[idx[0]] }, loops: [{ type: 'OUTER', coedges: fe.map((edgeId) => ({ edgeId })) }] });
  }
  return { id, type: 'solid', faces, edges, vertices: P.map((p, i) => ({ id: vid(i), point: p })) };
}

const bodies = [box('JHD', 6 * IN, 4 * IN, 0.25 * IN), box('JHH', 6 * IN, 4 * IN, 0.25 * IN), box('JKD', 1 * IN, 1 * IN, 10 * IN)];
const partsList = [
  { partId: 'JHD', name: '26O-E001', material: { displayName: '6061' } },
  { partId: 'JHH', name: 'Part 2', material: { displayName: '6061' } },
  { partId: 'JKD', name: 'Hex shaft', material: null },
];
const lunaParts = [
  { id: 11, project_id: 5, name: 'Plate', part_number: '26O-E001', part_status_id: 1, type: 'part', quantity: 1, tool_id: 2, notes: '' },
  { id: 12, project_id: 5, name: 'Shaft', part_number: '26O-E007', part_status_id: 2, type: 'part', quantity: 2, tool_id: 3, notes: `[onshape:${D}|${LD}|${LE}|JFD|]` },
  { id: 13, project_id: 5, name: 'Elevator', part_number: '26O-E100', part_status_id: 1, type: 'assembly', quantity: 1, status: { id: 1, name: 'Design' } },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function summarize(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 400);
  if (body instanceof FormData) {
    const out = [];
    for (const [k, v] of body.entries()) out.push(`${k}=${typeof v === 'string' ? v : `<file ${v.name} ${v.size}>`}`);
    return out.join('&');
  }
  return String(body);
}

let seq = 0;
globalThis.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const u = new URL(url);
  const p = u.pathname;
  fs.appendFileSync(LOG, `${method} ${u.host}${p}${u.search} ${await summarize(opts.body)}\n`);
  if (u.host === 'oauth.onshape.com') return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  if (u.host === 'cad.onshape.com') {
    const q = p.replace('/api', '');
    if (q.endsWith('/currentmicroversion')) return json({ microversion: 'mv1' });
    if (q === `/documents/d/${D}/w/${W}/elements`) return json([
      { id: E, elementType: 'PARTSTUDIO', name: 'PS' }, { id: A, elementType: 'ASSEMBLY', name: 'Asm' },
      { id: DRW, elementType: 'APPLICATION', dataType: 'onshape-app/drawing', name: '26O-E001 Drawing 1' }]);
    if (q.startsWith(`/documents/d/${D}/w/${W}/elements?`)) return json([]);
    if (q === `/parts/d/${D}/w/${W}/e/${E}`) return json(partsList);
    if (q.startsWith(`/parts/d/${LD}/`)) return json([{ partId: 'JFD', name: 'ThunderHex shaft', material: { displayName: 'Steel' } }]);
    if (q.endsWith('/features')) return json({ features: [{ featureId: 'Fder1', featureType: 'derived', suppressed: false }] });
    if (q.endsWith('/featurescript') && method === 'POST') return json({ result: { value: [{ value: 'JKD' }] } });
    if (q.endsWith('/bodydetails')) return q.includes(LD) ? json({ bodies: [box('JFD', 0.5 * IN, 0.5 * IN, 8 * IN)] }) : json({ bodies });
    if (q.includes('/boundingboxes')) return json({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.1, highY: 0.05, highZ: 0.006 });
    if (q.includes('/shadedviews')) return json({ images: [Buffer.from('PNGDATA').toString('base64')] });
    if (q.endsWith('/massproperties')) return json({ bodies: {
      JHD: { volume: [1], periphery: [2], mass: [3], principalInertia: [[1], [2], [3]] },
      JHH: { volume: [1], periphery: [2], mass: [3], principalInertia: [[1], [2], [3]] },
      JKD: { volume: [5], periphery: [2], mass: [3], principalInertia: [[1], [2], [3]] } } });
    if (q.startsWith(`/assemblies/d/${D}/w/${W}/e/${A}`)) return json({
      rootAssembly: { instances: [
        { id: 'I1', type: 'Part', name: '26O-E001 <1>', documentId: D, elementId: E, partId: 'JHD', documentMicroversion: 'f'.repeat(24) },
        { id: 'I2', type: 'Part', name: '26O-E001 <2>', documentId: D, elementId: E, partId: 'JHD', documentMicroversion: 'f'.repeat(24) },
        { id: 'I3', type: 'Part', name: 'Part 2 <1>', documentId: D, elementId: E, partId: 'JHH', documentMicroversion: 'f'.repeat(24) },
        { id: 'I4', type: 'Part', name: 'ThunderHex shaft <1>', documentId: LD, elementId: LE, partId: 'JFD', documentVersion: LV },
        { id: 'I5', type: 'Part', name: '10-32 SHCS <1>', documentId: LD, elementId: LE, partId: 'JBD', documentVersion: LV, isStandardContent: true },
        { id: 'S1', type: 'Assembly', documentId: D, elementId: 'f'.repeat(24) },
      ] },
      subAssemblies: [{ documentId: D, elementId: 'f'.repeat(24), instances: [{ id: 'I6', type: 'Part', name: 'Part 2 <2>', documentId: D, elementId: E, partId: 'JHH', documentMicroversion: 'f'.repeat(24) }] }],
      parts: [] });
    if (q.startsWith('/metadata/')) {
      if (method === 'POST') return json({});
      if (q.includes('/p/')) return json({ properties: [{ name: 'Name', propertyId: 'pName', value: 'x' }, { name: 'Part number', propertyId: 'pNum', value: '' }, { name: 'Title 1', propertyId: 'pT1', value: '' }, { name: 'Description', propertyId: 'pDesc', value: '' }] });
      return json({ properties: [{ name: 'Part number', propertyId: 'dNum', value: '' }] });
    }
    // The document's existing drawing (26O-E001 Drawing 1) is an empty sheet.
    if (q.endsWith('/translations') && method === 'POST') return json({ id: `T${++seq}`, requestState: 'DONE', resultExternalDataIds: [`${q.includes(`/e/${DRW}/`) ? 'XE' : 'X'}${seq}`] });
    if (q.includes('/externaldata/')) {
      const views = q.includes('XE') ? '[]' : '[{"viewId":"V1","logicalId":"auto_main","position":{"x":4,"y":4},"viewToPaperMatrix":[1,0,0,4,0,1,0,4,0,0,1,0]}]';
      return new Response(q.includes('X') && opts.headers && opts.headers.Accept === 'application/octet-stream' ? `{"sheets":[{"views":${views}}]}` : 'BYTES', { status: 200 });
    }
    if (q === '/users/sessioninfo') return json({ name: 'Test Student' });
    // A drawing for 26O-E099 is one where Onshape refuses every view.
    if (q.startsWith('/drawings/') && method === 'POST' && q.endsWith('/create')) {
      return json({ id: 'c'.repeat(23) + (/^26O-E099/.test(JSON.parse(opts.body).drawingName) ? '8' : '9') });
    }
    if (q.startsWith('/drawings/') && q.includes('c'.repeat(23) + '8/modify') && method === 'POST') {
      return json({ id: 'M2', requestState: 'DONE', output: JSON.stringify({ results: [{ status: 'Failed', errorDescription: 'Part not found' }] }) });
    }
    if (q.startsWith('/drawings/') && q.includes('/modify') && method === 'POST') return json({ id: 'M1', requestState: 'DONE', results: [] });
    if (q.startsWith('/elements/') && method === 'DELETE') return json({});
    if (q.startsWith('/drawings/modify/status')) return json({ requestState: 'DONE', output: '{}' });
    return json({ unknown: q }, 404);
  }
  if (u.host === 'build.lunatecs.org') {
    const q = p.replace('/api/v1', '');
    const page = (data) => json({ data, next_page_url: null });
    if (q === '/projects') return page([{ id: 5, name: 'Offseason', part_number_prefix: '26O-E' }, { id: 6, name: 'Old', completed_at: '2025' }]);
    if (q === '/tools') return page([{ id: 3, name: 'Lathe', is_active: true, order: 2 }, { id: 2, name: 'CNC Router', is_active: true, order: 1 }, { id: 4, name: 'Old', is_active: false, order: 0 }]);
    if (q === '/material-thicknesses') return page([{ id: 8, name: '1/4', order: 2 }, { id: 7, name: '1/8', order: 1 }]);
    if (q === '/parts' && method === 'GET') {
      const pid = Number(u.searchParams.get('project_id'));
      return page(pid ? lunaParts.filter((x) => x.project_id === pid) : lunaParts);
    }
    if (q === '/parts' && method === 'POST') {
      const name = opts.body.get('name');
      if (name === 'bad') return json({ message: 'nope', errors: { name: ['The name is bad.'] } }, 422);
      return json({ data: { id: 99, part_number: opts.body.get('part_number') || 'AUTO-1', name } }, 201);
    }
    let m = q.match(/^\/parts\/(\d+)$/);
    if (m && method === 'GET') { const x = lunaParts.find((y) => y.id === Number(m[1])); return x ? json({ data: { ...x, status: { id: x.part_status_id, name: `S${x.part_status_id}` } } }) : json({}, 404); }
    if (m && method === 'PUT') return json({ data: {} });
    m = q.match(/^\/parts\/(\d+)\/attachments$/);
    if (m && method === 'GET') return page(m[1] === '11' ? [{ original_filename: 'a.pdf', revision: 2 }, { extension: 'dxf', revision: 1 }] : []);
    if (m && method === 'POST') return m[1] === '666' ? json({ errors: { files: ['too big'] } }, 422) : json({ data: [] }, 201);
    return json({ unknown: q }, 404);
  }
  throw new Error(`unmocked host ${u.host}`);
};
