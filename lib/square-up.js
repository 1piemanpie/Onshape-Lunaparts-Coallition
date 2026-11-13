// Parts modelled at an angle in their Part Studio (Micah 2026-11-13: an
// elevator tube like 26O-E007 is tilted two ways at once, and the team can't
// model it square to the origin). Onshape's drawing views can only look
// along the Part Studio's X, Y or Z axis, so such a part comes out slanted in
// every view, and the shape checks can't tell it's a tube.
//
// The fix: work out the part's own square directions from its faces, then
//   - analyse a turned copy of its bodydetails (no Onshape calls), and
//   - draw it from a helper assembly tab holding one copy of the part,
//     turned by the same rotation, so the standard views see it square.
// The helper costs 4 Onshape calls the first time (make the tab, insert the
// part, read the instance id, turn it) and 2 when it's reused on a RETRY.
// Square parts are left alone and cost nothing extra.

const vec = (p) => (!p ? null : Array.isArray(p) ? p.slice(0, 3).map(Number) : [Number(p.x), Number(p.y), Number(p.z)]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null; };
const kindOf = (d) => String((d && d.type) || '').toLowerCase();

const SQUARE = 0.9999; // a direction this close to an axis counts as on it

// The part's own three square directions, from its flat faces (weighted by
// area) and, for round parts, its biggest round face's axis. Returns a 3x3
// rotation (rows) that turns the part square to X, Y and Z, or null when
// the part is already square or has nothing to go by.
function partRotation(body) {
  const dirs = []; // { n, w } grouped by direction, either sign
  const add = (n, w) => {
    if (!n || !(w > 0)) return;
    const d = dirs.find((x) => Math.abs(dot(x.n, n)) > SQUARE);
    if (d) d.w += w; else dirs.push({ n, w });
  };
  let roundAxis = null; let roundArea = 0;
  for (const f of (body && body.faces) || []) {
    const s = f.surface || {};
    const k = kindOf(s);
    if (k === 'plane') add(unit(vec(s.normal) || [0, 0, 0]), f.area || 0);
    else if (k === 'cylinder' && (f.area || 0) > roundArea) { roundArea = f.area || 0; roundAxis = unit(vec(s.axis) || [0, 0, 0]); }
  }
  dirs.sort((a, b) => b.w - a.w);
  let first = dirs[0] ? dirs[0].n : null;
  let second = null;
  if (first) second = (dirs.find((d) => Math.abs(dot(d.n, first)) < 1e-3) || {}).n || null;
  // A round shaft or spacer: its axis, plus any flat face across it.
  if (roundAxis && roundArea > (dirs[0] ? dirs[0].w : 0)) {
    first = roundAxis;
    second = (dirs.find((d) => Math.abs(dot(d.n, roundAxis)) < 1e-3) || {}).n || null;
  } else if (first && !second && roundAxis && Math.abs(dot(roundAxis, first)) < 1e-3) {
    second = roundAxis;
  }
  if (!first) return null;
  if (!second) {
    // Only one square direction known: any two directions across it will do
    // for the views (a round part looks the same from every side).
    const helper = Math.abs(first[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    second = unit(cross(first, helper));
  }
  const third = unit(cross(first, second));
  const frame = [first, second, third];
  if (frame.every((v) => Math.max(...v.map(Math.abs)) > SQUARE)) return null;
  // A square part with one big slanted face (a chamfer, an angled cut) is
  // still square: keep it when most of its flat area already faces along
  // the Part Studio axes.
  const along = (axes) => dirs.filter((d) => axes.some((a) => Math.abs(dot(a, d.n)) > SQUARE)).reduce((t, d) => t + d.w, 0);
  if (along([[1, 0, 0], [0, 1, 0], [0, 0, 1]]) >= 0.9 * along(frame)) return null;

  // Give each of the part's directions the Part Studio axis it's closest to
  // (so a part tilted a few degrees keeps its long side where it was), and
  // point it the positive way.
  const rows = [null, null, null];
  const pairs = [];
  frame.forEach((v, i) => [0, 1, 2].forEach((ax) => pairs.push({ i, ax, c: Math.abs(v[ax]) })));
  pairs.sort((a, b) => b.c - a.c);
  const used = new Set();
  for (const p of pairs) {
    if (rows[p.ax] || used.has(p.i)) continue;
    const v = frame[p.i];
    rows[p.ax] = v[p.ax] < 0 ? v.map((x) => -x) : v.slice();
    used.add(p.i);
  }
  // Keep it a turn, not a mirror.
  if (dot(cross(rows[0], rows[1]), rows[2]) < 0) rows[2] = rows[2].map((x) => -x);
  return rows;
}

const turn = (R, v) => [dot(R[0], v), dot(R[1], v), dot(R[2], v)];

const VECTOR_KEYS = ['normal', 'origin', 'axis', 'direction', 'xAxis', 'yAxis', 'zAxis', 'startPoint', 'endPoint', 'midPoint', 'point'];

// A copy of a bodydetails body turned by R about the Part Studio origin,
// matching where the helper assembly puts the turned copy of the part.
function turnBody(body, R) {
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object') return x;
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      const p = VECTOR_KEYS.includes(k) ? vec(v) : null;
      out[k] = p && p.every(Number.isFinite) ? turn(R, p) : walk(v);
    }
    return out;
  };
  return walk(body);
}

// { rotation, body } for a part modelled at an angle, else null.
function squareUp(body) {
  const R = partRotation(body);
  return R ? { rotation: R, body: turnBody(body, R) } : null;
}

// Angle (degrees) between the part's directions and the Part Studio's, for
// messages.
function tiltDegrees(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180 / Math.PI;
}

// Onshape's 4x4 occurrence transform (row by row, metres): the turn only.
function transform16(R) {
  return [...R[0], 0, ...R[1], 0, ...R[2], 0, 0, 0, 0, 1].map((x) => Math.round(x * 1e12) / 1e12);
}

// Makes (or reuses) the helper assembly tab "<part number> squared" holding
// one copy of the part turned square, and returns the drawing reference for
// it. reference: the part's own drawing reference ({ elementId, idTag,
// documentId?, versionId?, configuration? }). existing: the helper tab's id
// when one is already in the document.
async function squaredCopy(api, ctx, { reference, rotation, name, existing = null }) {
  const base = `/assemblies/d/${ctx.documentId}/w/${ctx.workspaceId}`;
  let asmId = existing;
  let instanceId = null;
  if (asmId) {
    const def = await api(`${base}/e/${asmId}`);
    const list = (def && def.rootAssembly && def.rootAssembly.instances) || [];
    if (list.length === 1) instanceId = list[0].id;
    else asmId = null; // someone changed it: make a fresh one
  }
  if (!asmId) {
    const made = await api(base, { method: 'POST', body: JSON.stringify({ name }) });
    asmId = made.id || made.elementId || (made.element && made.element.id);
    if (!asmId) throw new Error('Onshape made the helper tab but didn\'t say which tab it is.');
    const insert = {
      documentId: reference.documentId || ctx.documentId,
      elementId: reference.elementId,
      partId: reference.idTag,
      isAssembly: false,
      isWholePartStudio: false,
    };
    if (reference.versionId) insert.versionId = reference.versionId;
    if (reference.configuration) insert.configuration = reference.configuration;
    await api(`${base}/e/${asmId}/instances`, { method: 'POST', body: JSON.stringify(insert) });
    const def = await api(`${base}/e/${asmId}`);
    const list = (def && def.rootAssembly && def.rootAssembly.instances) || [];
    if (!list.length) throw new Error('The part didn\'t go into the helper tab.');
    instanceId = list[0].id;
  }
  // Absolute, so doing it again on a reused tab changes nothing.
  await api(`${base}/e/${asmId}/occurrencetransforms`, {
    method: 'POST',
    body: JSON.stringify({ isRelative: false, occurrences: [{ path: [instanceId] }], transform: transform16(rotation) }),
  });
  return { elementId: asmId };
}

module.exports = { partRotation, turnBody, squareUp, squaredCopy, tiltDegrees, transform16 };
