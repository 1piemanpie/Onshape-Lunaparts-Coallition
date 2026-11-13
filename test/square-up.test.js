// Parts modelled at an angle in their Part Studio (like the elevator tube
// 26O-E007, tilted two ways): the shape checks turn a copy square first,
// and the drawing is made from a turned copy in a helper assembly tab.
const test = require('node:test');
const assert = require('node:assert');
const { squareUp, turnBody, squaredCopy, transform16 } = require('../lib/square-up');
const { analyzePart } = require('../lib/drawings');
const { detectPart, bodyBox } = require('../lib/detect');

const IN = 0.0254;
const near = (a, b, tol = 0.002) => Math.abs(a - b) <= tol;
const m = (p) => p.map((v) => v * IN);

// A 1" x 1" x 0.063" punch tube, 31.5" long along X, holes every 0.5".
function tube(L = 31.5, w = 1, t = 0.063) {
  const faces = [];
  const plane = (n, o, area) => faces.push({ id: `F${faces.length}`, area: area * IN * IN, surface: { type: 'PLANE', normal: n, origin: m(o) } });
  for (const [ax, n] of [[1, [0, 1, 0]], [2, [0, 0, 1]]]) {
    for (const pos of [0, t, w - t, w]) {
      const o = [0, w / 2, w / 2]; o[ax] = pos;
      plane(n, o, L * (pos === 0 || pos === w ? w : w - 2 * t));
    }
  }
  plane([1, 0, 0], [0, w / 2, w / 2], w * w - (w - 2 * t) ** 2);
  plane([1, 0, 0], [L, w / 2, w / 2], w * w - (w - 2 * t) ** 2);
  const r = 0.098;
  for (let x = 0.25; x < L; x += 0.5) {
    for (const axis of [[0, 0, 1], [0, 1, 0]]) {
      faces.push({ id: `F${faces.length}`, area: 2 * Math.PI * r * t * IN * IN, surface: { type: 'CYLINDER', axis, origin: m([x, w / 2, w / 2]), radius: r * IN } });
    }
  }
  const vertices = [];
  for (const x of [0, L]) for (const y of [0, w]) for (const z of [0, w]) vertices.push({ id: `V${vertices.length}`, point: m([x, y, z]) });
  return { faces, edges: [], vertices };
}

// Turned 20 degrees about Z, then 12 degrees about Y: no Part Studio view
// sees it square.
function compound() {
  const a = 20 * Math.PI / 180; const b = -12 * Math.PI / 180;
  const Rz = [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const Ry = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  return Ry.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * Rz[k][j], 0)));
}

test('a square part is left alone', () => {
  assert.strictEqual(squareUp(tube()), null);
});

test('a tube tilted two ways reads as the same tube once squared', () => {
  const tilted = turnBody(tube(), compound());
  assert.notStrictEqual(analyzePart(tilted, bodyBox(tilted)).type, 'tube');
  const sq = squareUp(tilted);
  assert.ok(sq, 'should be found tilted');
  const info = analyzePart(sq.body, bodyBox(sq.body));
  assert.strictEqual(info.type, 'tube');
  assert.ok(near(info.length, 31.5), `length ${info.length}`);
  assert.ok(near(info.width, 1) && near(info.height, 1), `${info.width} x ${info.height}`);
  assert.ok(near(info.wall, 0.063), `wall ${info.wall}`);
  // The panel's auto-detect sees a tube too.
  assert.strictEqual(detectPart(tilted).type, 'tube');
  // The rotation is a turn, not a mirror.
  const R = sq.rotation;
  const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
  assert.ok(near(det, 1, 1e-9));
});

test('a square part with one big slanted face stays square', () => {
  const body = tube(4, 2, 0.5);
  body.faces.push({ id: 'chamfer', area: 30 * IN * IN, surface: { type: 'PLANE', normal: [Math.SQRT1_2, Math.SQRT1_2, 0], origin: [0, 0, 0] } });
  assert.strictEqual(squareUp(body), null);
});

test('helper tab: make it, insert the part, turn it (4 calls); reuse it (2 calls)', async () => {
  const R = squareUp(turnBody(tube(), compound())).rotation;
  const calls = [];
  const api = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'POST' && /\/w\/W$/.test(path)) return { id: 'ASM' };
    if (!opts.method) return { rootAssembly: { instances: [{ id: 'INST' }] } };
    return {};
  };
  const ctx = { documentId: 'D', workspaceId: 'W' };
  const ref = await squaredCopy(api, ctx, { reference: { elementId: 'PS', idTag: 'JHD' }, rotation: R, name: '26O-E007 squared' });
  assert.deepStrictEqual(ref, { elementId: 'ASM' });
  assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /assemblies/d/D/w/W',
    'POST /assemblies/d/D/w/W/e/ASM/instances',
    'GET /assemblies/d/D/w/W/e/ASM',
    'POST /assemblies/d/D/w/W/e/ASM/occurrencetransforms',
  ]);
  assert.deepStrictEqual(calls[1].body, { documentId: 'D', elementId: 'PS', partId: 'JHD', isAssembly: false, isWholePartStudio: false });
  assert.deepStrictEqual(calls[3].body, { isRelative: false, occurrences: [{ path: ['INST'] }], transform: transform16(R) });

  calls.length = 0;
  await squaredCopy(api, ctx, { reference: { elementId: 'PS', idTag: 'JHD' }, rotation: R, name: '26O-E007 squared', existing: 'ASM' });
  assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'GET /assemblies/d/D/w/W/e/ASM',
    'POST /assemblies/d/D/w/W/e/ASM/occurrencetransforms',
  ]);
});
