// Sends the same ~150 requests to the server every time (every route,
// logged out, Part Studio, assembly, bad input) and prints one line each.
const BASE = process.env.BASE || 'http://127.0.0.1:3999';
const D = 'd'.repeat(24), W = 'a'.repeat(24), E = 'e'.repeat(24), A = 'b'.repeat(24), DRW = 'c'.repeat(24);

async function call(cookie, method, path, body, extraHeaders = {}) {
  const headers = { 'X-Forwarded-Proto': 'https', ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') { payload = body; headers['Content-Type'] = 'application/json'; }
    else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  }
  return fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
}

async function login(elementId, extra = '') {
  const r = await call(null, 'GET', `/oauth/login?documentId=${D}&workspaceId=${W}&elementId=${elementId}${extra}`);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  const cb = await call(cookie, 'GET', `/oauth/callback?code=abc&state=${state}`);
  return { cookie, cb: `${cb.status} ${cb.headers.get('location')}` };
}

const out = [];
async function rec(name, cookie, method, path, body, h) {
  const r = await call(cookie, method, path, body, h);
  let text = await r.text();
  text = text.replace(/"since":"[^"]+"/, '"since":"X"');
  out.push(JSON.stringify({ name, status: r.status, calls: r.headers.get('x-onshape-calls'), total: r.headers.get('x-onshape-calls-total'), type: (r.headers.get('content-type') || '').split(';')[0], loc: r.headers.get('location'), cache: r.headers.get('cache-control'), body: text.slice(0, 3000) }));
}

(async () => {
  // anonymous
  for (const [m, p] of [['GET', '/health'], ['GET', '/api/session'], ['GET', '/api/usage'], ['GET', '/api/onshape/parts'], ['GET', '/api/onshape/part-shape?partId=JHD'],
    ['GET', '/api/onshape/part-image?partId=JHD'], ['POST', '/api/onshape/twins'], ['GET', '/api/onshape/selected-part?selectionId=x'], ['GET', '/api/onshape/next-number?prefix=26O-E'],
    ['POST', '/api/onshape/rename'], ['GET', '/api/onshape/drawings'], ['POST', '/api/onshape/make-drawing'], ['GET', '/api/luna/options'], ['GET', '/api/luna/part-numbers'],
    ['GET', '/api/luna/part-files?number=x'], ['POST', '/api/luna/dxf-check'], ['POST', '/api/luna/parts/1/number'], ['GET', '/api/luna/assemblies?project_id=5'],
    ['GET', '/api/luna/statuses'], ['POST', '/api/luna/parts'], ['POST', '/api/luna/parts/1/attachments'], ['GET', '/oauth/callback?state=zzz'], ['GET', '/nope']]) {
    await rec(`anon ${m} ${p}`, null, m, p, m === 'POST' ? {} : undefined);
  }
  const bad = await call(null, 'GET', `/oauth/login?documentId=xyz&workspaceId=${W}&elementId=${E}`);
  out.push(JSON.stringify({ name: 'login bad ids', status: bad.status, loc: (bad.headers.get('location') || '').replace(/state=[0-9a-f]+/, 'state=S') }));

  const ps = await login(E);
  out.push(JSON.stringify({ name: 'ps callback', cb: ps.cb }));
  const c = ps.cookie;
  const again = await call(c, 'GET', `/oauth/login?documentId=${D}&workspaceId=${W}&elementId=${E}`);
  out.push(JSON.stringify({ name: 'login again', status: again.status, loc: again.headers.get('location') }));
  const force = await call(c, 'GET', `/oauth/login?documentId=${D}&workspaceId=${W}&elementId=${E}&force=1`);
  out.push(JSON.stringify({ name: 'login force', status: force.status, loc: (force.headers.get('location') || '').replace(/state=[0-9a-f]+/, 'state=S') }));
  // force left a new oauthState in the session; that's fine.
  const steps = [
    ['GET', '/api/session'],
    ['GET', '/api/onshape/parts'],
    ['GET', '/api/onshape/parts?refresh=1'],
    ['GET', '/api/onshape/parts?fresh=1'],
    ['GET', '/api/onshape/selected-part?selectionId=JHDF0'],
    ['GET', '/api/onshape/selected-part?selectionId=JHD'],
    ['GET', '/api/onshape/selected-part?selectionId=ZZZ'],
    ['GET', '/api/onshape/selected-part?selectionId='],
    ['GET', '/api/onshape/selected-part?selectionId=has%20space'],
    ['GET', '/api/onshape/selected-part?selectionId=a&selectionId=b'],
    ['GET', '/api/onshape/part-shape?partId=JHD'],
    ['GET', '/api/onshape/part-shape?partId=JKD'],
    ['GET', '/api/onshape/part-shape?partId=NOPE'],
    ['GET', '/api/onshape/part-shape'],
    ['GET', '/api/onshape/part-image?partId=JHD'],
    ['GET', '/api/onshape/part-image?partId=JHD'],
    ['GET', '/api/onshape/part-image?partId=%00'],
    ['POST', '/api/onshape/twins', { partIds: ['JHD', 'JHH', 'JKD', 'bad id', 5] }],
    ['POST', '/api/onshape/twins', { partIds: 'JHD' }],
    ['POST', '/api/onshape/twins', '[1,2]'],
    ['GET', '/api/onshape/next-number?prefix=26O-E'],
    ['GET', '/api/onshape/next-number?prefix=26O-E&project_id=5'],
    ['GET', '/api/onshape/next-number?prefix=26O-E&project_id=5&exclude=JHD,JHH'],
    ['GET', '/api/onshape/next-number?prefix=26O-E&project_id=abc'],
    ['GET', '/api/onshape/next-number?prefix=bad prefix'],
    ['GET', '/api/onshape/next-number'],
    ['POST', '/api/onshape/rename', { partId: 'JHH', name: '26O-E002' }],
    ['POST', '/api/onshape/rename', { partId: 'JHH', name: '  26O-E003  ' }],
    ['POST', '/api/onshape/rename', { partId: 'JHH', name: 'bad*name' }],
    ['POST', '/api/onshape/rename', { partId: '', name: 'x' }],
    ['POST', '/api/onshape/rename', { partId: 12, name: 34 }],
    ['GET', '/api/onshape/parts'],
    ['GET', '/api/onshape/drawings'],
    ['GET', '/api/onshape/drawings?refresh=1'],
    ['POST', '/api/onshape/make-drawing', { partId: 'JHD', partNumber: '26O-E001', partName: 'Plate', quantity: 2, material: '6061' }],
    ['POST', '/api/onshape/make-drawing', { partId: 'JHH', partNumber: '26O-E003', partName: '  Side   plate ', quantity: '99999', material: 'x' }],
    ['POST', '/api/onshape/make-drawing', { partId: 'JHH', partNumber: '26O-E099', partName: 'No views' }],
    ['POST', '/api/onshape/make-drawing', { partId: 'JHH', partNumber: '26O-E003', check: true }],
    ['POST', '/api/onshape/make-drawing', { partId: 'JHD', partNumber: '26O-E001', partName: 'Plate', check: true }],
    ['POST', '/api/onshape/make-drawing', { partId: 'JHH', partNumber: '' }],
    ['POST', '/api/onshape/make-drawing', { partId: 'bad id', partNumber: '1' }],
    ['POST', '/api/onshape/make-drawing', { partId: 'JHH', partNumber: 'x'.repeat(81) }],
    ['GET', '/api/luna/options'],
    ['GET', '/api/luna/part-numbers'],
    ['GET', '/api/luna/part-files?number=26o-e001'],
    ['GET', '/api/luna/part-files?number=26O-E007'],
    ['GET', '/api/luna/part-files?number=NOPE'],
    ['GET', '/api/luna/part-files'],
    ['POST', '/api/luna/dxf-check', { parts: [{ partId: 'JHD', number: '26O-E001' }, { partId: 'JKD', number: '26o-e007' }, { partId: 'JHH', number: 'NOPE' }, { partId: 'bad id', number: 'x' }, { partId: 'JHH' }, null] }],
    ['POST', '/api/luna/dxf-check', { parts: 'x' }],
    ['POST', '/api/luna/parts/11/number', { partNumber: '26O-E011' }],
    ['POST', '/api/luna/parts/11/number', { partNumber: '26o-e007' }],
    ['POST', '/api/luna/parts/77/number', { partNumber: '26O-E011' }],
    ['POST', '/api/luna/parts/abc/number', { partNumber: 'x' }],
    ['POST', '/api/luna/parts/1.5/number', { partNumber: 'x' }],
    ['POST', '/api/luna/parts/11/number', {}],
    ['GET', '/api/luna/assemblies?project_id=5'],
    ['GET', '/api/luna/assemblies?project_id=0'],
    ['GET', '/api/luna/assemblies?project_id=2.5'],
    ['GET', '/api/luna/assemblies'],
    ['GET', '/api/luna/statuses'],
    ['GET', '/api/luna/statuses'],
    ['POST', '/api/luna/parts', { projectId: 5, name: ' New plate ', partNumber: '26O-E050', statusId: 1, type: 'part', quantity: 2, toolId: '2', priority: 1, thicknessId: 7, cutLength: '1.5', leadTimeDays: '', description: ' d ', material: ' 6061 ' }],
    ['POST', '/api/luna/parts', { projectId: 5, name: 'Dup', partNumber: '26o-e001', statusId: 1, type: 'part', quantity: 1 }],
    ['POST', '/api/luna/parts', { projectId: 5, name: 'bad', statusId: 1, type: 'part', quantity: 1 }],
    ['POST', '/api/luna/parts', { projectId: 5, name: 'NoNum', statusId: 1, type: 'purchased', quantity: '3' }],
    ['POST', '/api/luna/parts', {}],
    ['POST', '/api/luna/parts', { projectId: '-1', name: 'x', statusId: 'abc', type: 'thing', quantity: 1.5, toolId: 'x', priority: -1, parentPartId: '2.2', thicknessId: 'NaN', cutLength: 'q', leadTimeDays: '1e2' }],
    ['POST', '/api/luna/parts', { projectId: 0, name: 'x', statusId: 0, type: 'part', quantity: 0 }],
    ['POST', '/api/luna/parts', { projectId: true, name: ['a'], statusId: [3], type: 'part', quantity: ' 4 ' }],
    ['POST', '/api/luna/parts', 'null'],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'JHD', partNumber: '26O-E001', drawingId: DRW, wantStep: true }],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'JHD', faceId: 'JHDF0', partNumber: '26O-E001', revision: 3 }],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'JHD', faceId: 'JHDF0', wantDxf: false, partNumber: 'a/b' }],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'JKD', partNumber: '26O-E009', dxfSides: [{ faceId: 'JKDF0', side: 'top' }, { faceId: 'JKDF1', side: 'Bad' }, { faceId: 'JKDF2', side: 'left' }] }],
    ['POST', '/api/luna/parts/666/attachments', { partId: 'JHD', partNumber: 'X' }],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'JHD', drawingId: 'nothex' }],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'bad id' }],
    ['POST', '/api/luna/parts/x/attachments', { partId: 'JHD' }],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'JHD', faceId: 'bad face', partNumber: 'X' }],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'JHD', wantDxf: false }],
    ['POST', '/api/luna/parts', '{bad json'],
    ['POST', '/api/onshape/make-drawing', { partId: 'JHH', partNumber: '26O-E070', quantity: '12abc', material: 7, partName: false }],
    ['POST', '/api/onshape/make-drawing', { partId: 'JHH', partNumber: '26O-E071', quantity: '2.7' }],
    ['POST', '/api/onshape/make-drawing', { partId: 0, partNumber: 5 }],
    ['POST', '/api/onshape/rename', { partId: 'JHH', name: false }],
    ['POST', '/api/onshape/rename', { partId: null, name: 'x' }],
    ['POST', '/api/luna/parts', { projectId: 5, name: false, statusId: 1, type: 'part', quantity: '' }],
    ['POST', '/api/luna/parts', { projectId: 5, name: 0, statusId: '1', type: 'part', quantity: null, cutLength: '-1', material: false }],
    ['POST', '/api/luna/parts', [1, 2]],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'JHD', faceId: 0, drawingId: '', revision: 'x', partNumber: 'R', dxfSides: 'no' }],
    ['POST', '/api/luna/parts/11/attachments', { partId: 'JHD', faceId: false, drawingId: 0, revision: '2', partNumber: 5, wantDxf: 0 }],
    ['POST', '/api/luna/parts/0/attachments', { partId: 'JHD' }],
    ['POST', '/api/luna/parts/11/number', { partNumber: 0 }],
    ['POST', '/api/luna/parts/11/number', [1]],
    ['POST', '/api/onshape/twins', { partIds: [null, 'JHD', {}, 'JHH'] }],
    ['POST', '/api/luna/dxf-check', { parts: [{ partId: 'JHD', number: 7 }, { partId: 'JHH', number: '  ' }, [1]] }],
    ['GET', '/api/onshape/next-number?prefix=26O-E&prefix=x'],
    ['GET', '/api/onshape/next-number?prefix=26O-E&project_id=5&project_id=6'],
    ['GET', '/api/onshape/next-number?prefix=26O-E&exclude=JHD&exclude=JHH'],
    ['GET', '/api/onshape/part-shape?partId[a]=1'],
    ['GET', '/api/luna/part-files?number=%20%20'],
    ['GET', '/api/luna/assemblies?project_id=5&project_id=5'],
    ['GET', '/api/usage'],
  ];
  for (const [m, p, b] of steps) await rec(`ps ${m} ${p} ${b ? JSON.stringify(b).slice(0, 120) : ''}`, c, m, p, b);

  const asm = await login(A);
  const a = asm.cookie;
  const asmSteps = [
    ['GET', '/api/onshape/parts'],
    ['GET', '/api/onshape/parts?fresh=1'],
    ['GET', '/api/onshape/selected-part?selectionId=JHDF0'],
  ];
  for (const [m, p, b] of asmSteps) await rec(`asm ${m} ${p}`, a, m, p, b);
  const listRes = await call(a, 'GET', '/api/onshape/parts');
  const list = JSON.parse(await listRes.text());
  const ids = list.parts.map((p) => p.partId);

  const linked = list.parts.find((p) => p.linked && p.name === "ThunderHex shaft");
  const local = list.parts.find((p) => !p.linked && p.name === 'Part 2');
  const more = [
    ['GET', `/api/onshape/part-shape?partId=${ids[0]}`],
    ['GET', `/api/onshape/part-shape?partId=a000000000000`],
    ['GET', `/api/onshape/part-image?partId=${linked.partId}`],
    ['POST', '/api/onshape/twins', { partIds: ids }],
    ['GET', '/api/onshape/next-number?prefix=26O-E'],
    ['POST', '/api/onshape/rename', { partId: linked.partId, name: '26O-E040' }],
    ['POST', '/api/onshape/rename', { partId: local.partId, name: '26O-E041' }],
    ['POST', '/api/onshape/rename', { partId: 'a999999999999', name: '26O-E041' }],
    ['GET', '/api/onshape/parts'],
    ['POST', '/api/onshape/make-drawing', { partId: linked.partId, partNumber: '26O-E007', partName: 'Shaft' }],
    ['POST', '/api/onshape/make-drawing', { partId: local.partId, partNumber: '26O-E041', partName: 'Side' }],
    ['POST', '/api/luna/parts', { projectId: 5, name: 'Linked shaft', partNumber: '26O-E060', statusId: 1, type: 'part', quantity: 1, onshapePartId: linked.partId }],
    ['POST', '/api/luna/parts/11/attachments', { partId: linked.partId, partNumber: '26O-E007', wantStep: true }],
    ['POST', '/api/luna/dxf-check', { parts: [{ partId: local.partId, number: '26O-E001' }] }],
    ['GET', '/api/usage'],
  ];
  for (const [m, p, b] of more) await rec(`asm ${m} ${p} ${b ? JSON.stringify(b).slice(0, 120) : ''}`, a, m, p, b);
  console.log(out.join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });
