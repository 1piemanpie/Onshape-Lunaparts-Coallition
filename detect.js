// Auto-detect (step 4): looks at a part's shape and suggests how it's made.
//
//   plate  thin and flat. Pockets (flat floors between the top and bottom)
//          mean the CNC mill, and the DXF is taken from the flat back side
//          so pocket outlines don't look like through-cuts.
//   tube   box tube. Bought pre-drilled when the 0.196" holes on the 0.5"
//          pattern run the whole length of every row. Then only holes and
//          cuts beyond that pattern need the mill, with a DXF of each side
//          that has them. When the 0.196" holes only cover part of the tube
//          (Micah 2026-11-03), it isn't pre-drilled stock: every hole is
//          drilled on the mill, so every side with holes gets a DXF.
//   round  shafts and spacers (lathe, no DXF).
//
// Everything comes from Onshape's bodydetails, which the server already
// caches once per Part Studio and document version. So this costs no extra
// Onshape calls per part. The answers are suggestions: the card fills them
// in and the user can change them.

const { analyzePart, sawNote } = require('./drawings');

const IN = 0.0254; // metres per inch
const STD_HOLE_IN = 0.196;
const STD_PITCH_IN = 0.5;
const TOL = 0.004; // inches

const vec = (p) => (!p ? null : Array.isArray(p) ? p.slice(0, 3).map(Number) : [Number(p.x), Number(p.y), Number(p.z)]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l ? [a[0] / l, a[1] / l, a[2] / l] : null; };
const kindOf = (desc) => String((desc && desc.type) || '').toLowerCase();
const inch = (p) => p.map((m) => m / IN);

// Which model axis (0 = X, 1 = Y, 2 = Z) a direction runs along, if any.
function axisOf(v) {
  if (!v) return -1;
  const i = [0, 1, 2].sort((a, b) => Math.abs(v[b]) - Math.abs(v[a]))[0];
  return Math.abs(v[i]) > 0.999 ? i : -1;
}

// Side names match Onshape's standard views, so they're easy to find.
const SIDE_NAMES = { '0+': 'right', '0-': 'left', '1+': 'back', '1-': 'front', '2+': 'top', '2-': 'bottom' };

// ---- bounding box straight from bodydetails (saves a call per part) -------
// Lines count by their ends; circles and arcs are sampled so a round end or
// a rounded corner still counts; other curves by their start, middle and end.
function circleNormal(edge) {
  const c = edge.curve || {};
  const n = unit(vec(c.normal) || vec(c.axis) || [0, 0, 0]);
  if (n) return n;
  const g = edge.geometry || {};
  const o = vec(c.origin);
  const s = vec(g.startPoint);
  const m = vec(g.midPoint);
  return o && s && m ? unit(cross(sub(s, o), sub(m, o))) : null;
}

// Angle swept by a circle edge (2*pi for a full circle), going from its start
// through its middle point to its end.
function arcSweep(edge) {
  const g = edge.geometry || {};
  const o = vec(edge.curve && edge.curve.origin);
  const s = vec(g.startPoint);
  const e = vec(g.endPoint);
  const m = vec(g.midPoint);
  const n = circleNormal(edge);
  if (!o || !s || !e || !n) return null;
  if (len(sub(s, e)) < 1e-7) return 2 * Math.PI;
  const u = sub(s, o);
  const ang = (p) => {
    const d = sub(p, o);
    const a = Math.atan2(dot(cross(u, d), n), dot(u, d));
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const te = ang(e);
  if (!m) return te;
  return ang(m) < te ? te : 2 * Math.PI - te;
}

function circlePoints(edge, steps = 24) {
  const o = vec(edge.curve.origin);
  const r = Number(edge.curve.radius);
  const n = circleNormal(edge);
  const s = vec((edge.geometry || {}).startPoint);
  if (!o || !(r > 0) || !n) return [];
  const u = unit(s ? sub(s, o) : cross(Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], n));
  if (!u) return [];
  const v = cross(n, u);
  const sweep = arcSweep(edge) || 2 * Math.PI;
  const pts = [];
  for (let k = 0; k <= steps; k += 1) {
    const t = (sweep * k) / steps;
    pts.push([0, 1, 2].map((i) => o[i] + r * (Math.cos(t) * u[i] + Math.sin(t) * v[i])));
  }
  return pts;
}

function bodyBox(body) {
  const pts = [];
  for (const edge of (body && body.edges) || []) {
    const g = edge.geometry || {};
    if (kindOf(edge.curve) === 'circle') pts.push(...circlePoints(edge));
    for (const p of [g.startPoint, g.endPoint, g.midPoint]) if (p) pts.push(vec(p));
  }
  for (const v of (body && body.vertices) || []) if (v.point) pts.push(vec(v.point));
  const good = pts.filter((p) => p && p.every(Number.isFinite));
  if (!good.length) return null;
  const lo = [0, 1, 2].map((i) => Math.min(...good.map((p) => p[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...good.map((p) => p[i])));
  return { lowX: lo[0], lowY: lo[1], lowZ: lo[2], highX: hi[0], highY: hi[1], highZ: hi[2] };
}

// ---- helpers over faces ---------------------------------------------------
function planesOf(body) {
  const out = [];
  for (const f of (body && body.faces) || []) {
    const s = f.surface || {};
    if (kindOf(s) !== 'plane' || !s.normal) continue;
    let n = unit(vec(s.normal));
    if (!n) continue;
    if (s.isOrientedWithFace === false) n = n.map((x) => -x);
    const o = inch(vec(s.origin) || [0, 0, 0]);
    const axis = axisOf(n);
    out.push({ face: f, id: f.id, n, axis, sign: axis >= 0 && n[axis] > 0 ? '+' : '-', pos: axis >= 0 ? o[axis] : null, area: (f.area || 0) / (IN * IN) });
  }
  return out;
}

// Every point on a face's edges, in inches (to tell where the face sits).
function facePoints(body, face) {
  const edgesById = new Map(((body && body.edges) || []).map((e) => [e.id, e]));
  const pts = [];
  for (const loop of face.loops || []) {
    for (const ce of loop.coedges || []) {
      const e = edgesById.get(ce.edgeId);
      const g = (e && e.geometry) || {};
      for (const p of [g.startPoint, g.endPoint, g.midPoint]) if (p) pts.push(inch(vec(p)));
    }
  }
  return pts;
}

const near = (a, b, tol = TOL) => Math.abs(a - b) <= tol;
const round = (v, step = 0.001) => Math.round(v / step) * step;
const fmt = (v) => {
  const s = (Math.round(v * 1000) / 1000).toFixed(3);
  return s.startsWith('0.') ? s.slice(1) : s;
};

// The value for LUNA's Cut Length: exact under 12" (calipers), otherwise
// rounded up to the next 1/16" (tape measure, faced down after).
function sawCut(length) {
  const cutTo = length < 12 ? round(length) : Math.ceil(length * 16 - 1e-6) / 16;
  return { length: round(length), cutTo: Number(cutTo.toFixed(4)), note: sawNote(length) };
}

// ---- plates ----------------------------------------------------------------
function plateDetails(body, info, box) {
  const thin = info.view;
  const lo = [box.lowX, box.lowY, box.lowZ][thin] / IN;
  const hi = [box.highX, box.highY, box.highZ][thin] / IN;
  const facing = planesOf(body).filter((p) => p.axis === thin);
  const floors = facing.filter((p) => !near(p.pos, lo) && !near(p.pos, hi));
  const depths = new Set();
  const fromSide = new Set();
  for (const f of floors) {
    // A pocket floor faces out of the side it was cut from.
    fromSide.add(f.sign);
    depths.add(fmt(f.sign === '+' ? hi - f.pos : f.pos - lo));
  }
  const pockets = floors.length > 0;
  // DXF from the outer face on the side without pockets, so pocket outlines
  // aren't mistaken for through-cuts. Pockets on both sides: largest face.
  let dxfFace = null;
  if (pockets && fromSide.size === 1) {
    const back = fromSide.has('+') ? '-' : '+';
    dxfFace = facing.filter((p) => p.sign === back && near(p.pos, back === '+' ? hi : lo))
      .sort((a, b) => b.area - a.area)[0] || null;
  }
  const notes = [];
  if (pockets) {
    notes.push(`Pockets or steps ${[...depths].map((d) => `${d}"`).join(', ')} deep: needs the CNC mill.`);
    notes.push(fromSide.size === 1
      ? 'The DXF uses the flat back side (through-cuts only). Pocket depths go on the drawing.'
      : 'Pockets on both sides: check the DXF face (select the side to cut from).');
  }
  return {
    type: 'plate',
    thickness: Number(info.thickness.toFixed(4)),
    pockets,
    pocketDepths: [...depths],
    machine: pockets ? 'mill' : 'cnc',
    needsDxf: true,
    dxfFaceId: dxfFace ? dxfFace.id : null,
    summary: pockets ? `Pocketed plate, ${fmt(info.thickness)}" thick` : `Plate, ${fmt(info.thickness)}" thick`,
    notes,
  };
}

// ---- box tube ----------------------------------------------------------------
function tubeDetails(body, info, box) {
  const a = info.horizontal; // length
  const crossAxes = [0, 1, 2].filter((i) => i !== a);
  const lo = inch([box.lowX, box.lowY, box.lowZ]);
  const hi = inch([box.highX, box.highY, box.highZ]);
  const planes = planesOf(body);

  // Walls: the outer face and the biggest inner face on each side.
  const band = {}; // side key -> [from, to] along its axis (the wall's material)
  const wallPos = {};
  for (const i of crossAxes) {
    const mid = (lo[i] + hi[i]) / 2;
    const facing = planes.filter((p) => p.axis === i);
    const innerLo = facing.filter((p) => p.pos > lo[i] + TOL && p.pos <= mid).sort((x, y) => y.area - x.area)[0];
    const innerHi = facing.filter((p) => p.pos < hi[i] - TOL && p.pos > mid).sort((x, y) => y.area - x.area)[0];
    const wLo = innerLo ? innerLo.pos : lo[i] + (info.wall || 0.125);
    const wHi = innerHi ? innerHi.pos : hi[i] - (info.wall || 0.125);
    wallPos[i] = [lo[i], wLo, wHi, hi[i]];
    band[`${i}-`] = [lo[i] - TOL, wLo + TOL];
    band[`${i}+`] = [wHi - TOL, hi[i] + TOL];
  }
  const sideOfPoints = (pts) => {
    for (const key of Object.keys(band)) {
      const i = Number(key[0]);
      if (pts.length && pts.every((p) => p[i] >= band[key][0] && p[i] <= band[key][1])) return key;
    }
    return null;
  };

  // Holes and round cuts through the side walls, grouped so a hole's outer
  // and inner circles (or its two half-circles) count once.
  const groups = new Map();
  for (const edge of body.edges || []) {
    if (kindOf(edge.curve) !== 'circle') continue;
    const n = circleNormal(edge);
    const i = axisOf(n);
    if (i < 0 || i === a) continue; // corner radii and end features run along the length
    const o = inch(vec(edge.curve.origin));
    const d = (2 * Number(edge.curve.radius)) / IN;
    const mid = (lo[i] + hi[i]) / 2;
    const side = `${i}${o[i] > mid ? '+' : '-'}`;
    const j = crossAxes.find((k) => k !== i);
    const key = `${side}|${round(o[a], 0.002).toFixed(3)}|${round(o[j], 0.002).toFixed(3)}|${round(d, 0.002).toFixed(3)}`;
    const g = groups.get(key) || { side, along: o[a], across: o[j], d, levels: new Map() };
    const level = round(o[i], 0.002).toFixed(3);
    g.levels.set(level, (g.levels.get(level) || 0) + (arcSweep(edge) || 0));
    groups.set(key, g);
  }
  const holes = [];
  const arcs = [];
  for (const g of groups.values()) {
    const full = [...g.levels.values()].some((s) => s >= 2 * Math.PI - 0.05);
    (full ? holes : arcs).push(g);
  }

  // Flat cuts (slots, notches, windows): flat faces that aren't the walls or ends.
  const cuts = [];
  for (const p of planes) {
    if (p.axis < 0) continue;
    if (p.axis === a && (near(p.pos, lo[a]) || near(p.pos, hi[a]))) continue;
    if (p.axis !== a && wallPos[p.axis].some((w) => near(p.pos, w))) continue;
    const side = sideOfPoints(facePoints(body, p.face));
    if (side) cuts.push({ side });
  }
  const angledEnds = planes.some((p) => p.axis < 0);

  // Is it pre-drilled stock? Every row of 0.196" holes has to run the whole
  // length at 0.5" spacing. A spot on the pattern taken by a bigger hole
  // still counts as covered.
  const isStd = (h) => near(h.d, STD_HOLE_IN);
  const std = holes.filter(isStd);
  const rows = new Map();
  for (const h of std) {
    const key = `${h.side}|${round(h.across, 0.01).toFixed(2)}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(h);
  }
  const problems = [];
  for (const [key, row] of rows) {
    const [side, across] = key.split('|');
    const filled = holes.filter((h) => h.side === side && near(h.across, Number(across), 0.01));
    const ref = row[0].along;
    const onGrid = (h) => {
      const r = ((h.along - ref) / STD_PITCH_IN);
      return Math.abs(r - Math.round(r)) * STD_PITCH_IN <= 0.006;
    };
    const steps = new Set(filled.filter(onGrid).map((h) => Math.round((h.along - ref) / STD_PITCH_IN)));
    const first = Math.min(...steps);
    const last = Math.max(...steps);
    let gaps = 0;
    for (let k = first; k <= last; k += 1) if (!steps.has(k)) gaps += 1;
    const startGap = ref + first * STD_PITCH_IN - lo[a];
    const endGap = hi[a] - (ref + last * STD_PITCH_IN);
    if (gaps || startGap > 0.8 || endGap > 0.8 || row.some((h) => !onGrid(h))) problems.push(SIDE_NAMES[side]);
  }
  const preDrilled = std.length > 0 && problems.length === 0;

  // What has to be cut on the mill, by side.
  const extras = new Map();
  const add = (side, what) => {
    if (!extras.has(side)) extras.set(side, []);
    extras.get(side).push(what);
  };
  for (const h of holes) if (!preDrilled || !isStd(h)) add(h.side, `Ø${fmt(h.d)}`);
  for (const c of arcs) add(c.side, 'slot or round cut');
  for (const c of cuts) add(c.side, 'flat cut');

  const countList = (items) => {
    const counts = new Map();
    for (const it of items) counts.set(it, (counts.get(it) || 0) + 1);
    return [...counts].map(([what, n]) => (what.startsWith('Ø') ? `${n}x ${what}` : `${n} ${what}${n > 1 ? 's' : ''}`)).join(', ');
  };
  const dxfSides = [];
  for (const [side, items] of extras) {
    const i = Number(side[0]);
    const outer = planes.filter((p) => p.axis === i && p.sign === side[1] && near(p.pos, side[1] === '+' ? hi[i] : lo[i]))
      .sort((x, y) => y.area - x.area)[0];
    dxfSides.push({ side: SIDE_NAMES[side], faceId: outer ? outer.id : null, what: countList(items) });
  }
  // Holes straight through both walls show up on both sides, so both get a DXF.
  dxfSides.sort((x, y) => x.side.localeCompare(y.side));

  const notes = [];
  if (std.length && !preDrilled) {
    notes.push(`The ${STD_HOLE_IN}" holes don't run the whole length (${problems.join(', ')} side${problems.length > 1 ? 's' : ''}), so this isn't pre-drilled tube: every hole is drilled on the CNC mill.`);
  } else if (preDrilled) {
    notes.push(`Pre-drilled tube: the ${STD_HOLE_IN}" holes run the whole length.`);
  }
  if (dxfSides.length) notes.push(`DXF of the ${dxfSides.map((s) => `${s.side} side (${s.what})`).join(', ')}.`);
  else notes.push('Nothing to mill, so no DXF: just cut to length.');
  if (angledEnds) notes.push('An end is cut at an angle: put the angle on the drawing.');

  return {
    type: 'tube',
    width: Number(info.width.toFixed(4)),
    height: Number(info.height.toFixed(4)),
    wall: info.wall ? Number(info.wall.toFixed(4)) : null,
    preDrilled,
    standardHoles: std.length,
    dxfSides: dxfSides.filter((s) => s.faceId),
    needsDxf: dxfSides.length > 0,
    machine: dxfSides.length ? 'mill' : 'saw',
    sawCut: sawCut(info.length),
    summary: `Box tube ${fmt(info.width)}" x ${fmt(info.height)}"${info.wall ? ` x ${fmt(info.wall)}" wall` : ''}, ${fmt(info.length)}" long`,
    notes,
  };
}

// body: one body from bodydetails. box: the part's bounding box in metres,
// or null to work it out from the body.
function detectPart(body, box = null) {
  const b = box || bodyBox(body);
  if (!body || !b) return null;
  const info = analyzePart(body, b);
  if (info.type === 'plate') return plateDetails(body, info, b);
  if (info.type === 'tube') return tubeDetails(body, info, b);
  if (info.type === 'round') {
    return {
      type: 'round',
      needsDxf: false,
      machine: 'lathe',
      sawCut: sawCut(info.length),
      summary: `Round ${info.subtype}, Ø${fmt(info.od)}, ${fmt(info.length)}" long`,
      notes: [],
    };
  }
  return { type: 'other', needsDxf: null, machine: null, summary: '', notes: [] };
}

module.exports = { detectPart, bodyBox, sawCut, SIDE_NAMES };
