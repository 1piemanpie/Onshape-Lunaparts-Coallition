// Makes a real, editable Onshape drawing for one part, in the team's layouts
// (the ones Micah picked from the MK5n rail, TSHAFT01, T08 and TS02 examples):
//
//   plate   flat view with overall W x H, grouped hole callouts
//           ("3x Ø.200", "2x Ø1.125 REAM", "2x 10-32 TAP"), edge view with the
//           thickness, iso view; notes: Qty, Material, Thickness
//   tube    wide side view with the length and the first hole's offset,
//           narrow side view when it has holes, end view with W, H, wall;
//           notes: Qty, `2"x1"x0.063" punch tube`, saw cut
//   round   (round shafts, plain spacers) side view with the length, end
//           view with the OD and bore, iso; notes: Qty, Material, saw cut
//   other   (printed brackets, spools ...) three views + iso, overall sizes,
//           and a note to add the details by hand
//
// It works in three steps against Onshape's Drawings API:
//   1. create an empty drawing tab named "<part> Drawing 1"
//   2. add the views (onshapeCreateViews)
//   3. read back where Onshape put each edge (jsongeometry) and add the notes,
//      dimensions and callouts (onshapeCreateAnnotations)
// Anything that fails in step 3 is reported, and the drawing is still kept so
// it can be finished by hand.
//
// planDrawing() and annotationsFor() are plain functions (no Onshape calls),
// so they can be tested with saved data.

const IN = 0.0254; // metres per inch; Onshape's API works in metres

// ---- small helpers -------------------------------------------------------
const vec = (p) => (!p ? null : Array.isArray(p) ? p.slice(0, 3).map(Number) : [Number(p.x), Number(p.y), Number(p.z)]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const kindOf = (desc) => String((desc && desc.type) || '').toLowerCase();

// ".250", "1.125" (drawings drop the leading zero below 1)
function fmt(v) {
  const s = (Math.round(v * 1000) / 1000).toFixed(3);
  return s.startsWith('0.') ? s.slice(1) : s;
}

// 5.0625 -> 5 1/16
function frac(v, den = 16) {
  const n = Math.round(v * den);
  const whole = Math.floor(n / den);
  let num = n - whole * den;
  let d = den;
  while (num && num % 2 === 0 && d % 2 === 0) { num /= 2; d /= 2; }
  if (!num) return `${whole}"`;
  return whole ? `${whole} ${num}/${d}"` : `${num}/${d}"`;
}

// Short tube sizes the way the team writes them: 2, 1, 0.063
function short(v) {
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
}

// Saw cuts: under 12" it's measured with calipers, so the exact length.
// Longer parts use a tape measure: round up to the next 1/16" and face down.
function sawNote(length) {
  if (length < 12) return `Cut to ${fmt(length)} on bandsaw`;
  const up = Math.ceil(length * 16 - 1e-6) / 16;
  if (Math.abs(up - length) < 1e-4) return `Cut to ${frac(up)} on bandsaw`;
  return `Pre-cut to ${frac(up)} on bandsaw, face to ${fmt(length)}`;
}

// Bearing bores are reamed (1.125" and 0.875"). Models sometimes already
// have the hole a little small for the reamer, down to 0.0105" under.
function reamSize(d) {
  return [1.125, 0.875].find((n) => d >= n - 0.0105 && d <= n + 0.0005) || null;
}

// Tap drill -> thread. Tight tolerance so a plain .200 clearance hole isn't
// mistaken for a 1/4-20 tap drill (.201).
const TAPS = [[0.0700, '4-40'], [0.0890, '4-40'], [0.1065, '6-32'], [0.1360, '8-32'], [0.1590, '10-32'],
  [0.1495, '10-24'], [0.2010, '1/4-20'], [0.2130, '1/4-28'], [0.2570, '5/16-18'], [0.3125, '3/8-16']];
function tapSize(d) {
  const hit = TAPS.find(([drill]) => Math.abs(d - drill) <= 0.0005);
  return hit ? hit[1] : null;
}

function holeLabel(d, count) {
  const pre = count > 1 ? `${count}x ` : '';
  const ream = reamSize(d);
  if (ream) return `${pre}Ø${fmt(ream)} REAM`;
  const tap = tapSize(d);
  if (tap) return `${pre}${tap} TAP`;
  return `${pre}Ø${fmt(d)}`;
}

// ---- 1. what kind of part is it? -----------------------------------------
// body: one body from Onshape's bodydetails; box: the part's bounding box
// ({lowX, highX, ...} in metres). Returns everything the layout needs.
function analyzePart(body, box) {
  const low = [box.lowX, box.lowY, box.lowZ].map((m) => m / IN);
  const high = [box.highX, box.highY, box.highZ].map((m) => m / IN);
  const ext = high.map((h, i) => h - low[i]);
  const order = [0, 1, 2].sort((a, b) => ext[b] - ext[a]); // longest first
  const faces = (body && body.faces) || [];

  const planes = [];
  const cylinders = [];
  for (const f of faces) {
    const s = f.surface || {};
    const k = kindOf(s);
    if (k === 'plane' && s.normal) {
      planes.push({ n: vec(s.normal), o: vec(s.origin) || [0, 0, 0], area: (f.area || 0) / (IN * IN) });
    } else if (k === 'cylinder' && s.radius) {
      const r = s.radius / IN;
      const area = (f.area || 0) / (IN * IN);
      cylinders.push({ d: 2 * r, axis: vec(s.axis) || [0, 0, 1], o: vec(s.origin) || [0, 0, 0], h: area / (2 * Math.PI * r) });
    }
  }
  // Which model axis (0 = X, 1 = Y, 2 = Z) a direction runs along, if any.
  const axisOf = (v) => {
    if (!v) return -1;
    const i = [0, 1, 2].sort((a, b) => Math.abs(v[b]) - Math.abs(v[a]))[0];
    return Math.abs(v[i]) > 0.999 ? i : -1;
  };
  const warnings = [];
  const biggest = planes.slice().sort((a, b) => b.area - a.area)[0];
  // Flat area facing along each model axis (a pocketed plate's top is split
  // into many faces, so add them up rather than trusting the single biggest).
  const flatArea = [0, 0, 0];
  for (const p of planes) { const i = axisOf(p.n); if (i >= 0) flatArea[i] += p.area; }
  const mostFlat = [0, 1, 2].sort((x, y) => flatArea[y] - flatArea[x])[0];

  // Plate: thin, and its biggest flat face faces along the thin direction.
  const thin = order[2];
  if (planes.length && ext[thin] <= 0.75 && ext[order[1]] >= 2.5 * ext[thin] && mostFlat === thin) {
    const T = ext[thin];
    const minWH = Math.min(ext[order[0]], ext[order[1]]);
    const groups = new Map();
    for (const c of cylinders) {
      // Full-depth round holes only: a full cylinder wall's height (from its
      // area) equals the thickness; fillets and slot ends come out shorter.
      if (axisOf(c.axis) !== thin || Math.abs(c.h - T) > 0.01 || c.d >= 0.95 * minWH) continue;
      const key = (Math.round(c.d * 1000) / 1000).toFixed(3);
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const holes = [...groups].map(([d, count]) => ({ d: Number(d), count, label: holeLabel(Number(d), count) }))
      .sort((a, b) => b.d - a.d);
    return { type: 'plate', ext, view: thin, horizontal: order[0], vertical: order[1], thickness: T, holes, warnings };
  }

  const a = order[0];
  const L = ext[a];
  const cross = [order[1], order[2]];
  const coaxial = cylinders.filter((c) => axisOf(c.axis) === a);
  const sidePlanes = planes.filter((p) => axisOf(p.n) >= 0 && axisOf(p.n) !== a);

  // Box tube: long, with inner and outer walls on both cross axes.
  if (L >= 3 * ext[order[1]] && ext[order[1]] <= 2.6 && sidePlanes.length >= 8 && !coaxial.some((c) => c.d > 0.3)) {
    const wallOn = (i) => {
      const pos = [...new Set(sidePlanes.filter((p) => axisOf(p.n) === i).map((p) => Math.round(p.o[i] / IN * 1e4) / 1e4))].sort((x, y) => x - y);
      return pos.length >= 4 ? pos[1] - pos[0] : null;
    };
    const walls = cross.map(wallOn).filter((w) => w > 0);
    const wall = walls.length ? Math.min(...walls) : null;
    if (!wall) warnings.push('Couldn\'t measure the tube wall.');
    const holes = cylinders.filter((c) => c.d < 0.6 && axisOf(c.axis) >= 0 && axisOf(c.axis) !== a);
    const std = holes.length > 0 && holes.every((c) => Math.abs(c.d - 0.196) < 0.002);
    // Wide side: the face you see looking along the smaller cross size.
    const [big, small] = ext[cross[0]] >= ext[cross[1]] ? cross : [cross[1], cross[0]];
    const extra = new Map();
    for (const c of holes) {
      if (Math.abs(c.d - 0.196) < 0.002) continue;
      const key = fmt(c.d);
      extra.set(key, (extra.get(key) || 0) + 1);
    }
    const material = `${short(ext[big])}"x${short(ext[small])}"x${wall ? short(wall) : '?'}" ${std ? 'punch tube' : 'aluminium tube'}`;
    return {
      type: 'tube', ext, view: small, horizontal: a, vertical: big,
      length: L, width: ext[big], height: ext[small], wall, material,
      holesOnNarrow: holes.some((c) => axisOf(c.axis) === big),
      extraHoles: [...extra].map(([d, n]) => `${n}x Ø${d}`),
      warnings,
    };
  }

  // Round shaft or plain spacer: coaxial round faces as big as the part.
  const od = Math.max(0, ...coaxial.map((c) => c.d));
  if (od > 0 && Math.abs(od - Math.max(ext[order[1]], ext[order[2]])) < 0.01 && Math.abs(ext[order[1]] - ext[order[2]]) < 0.01) {
    const inner = coaxial.filter((c) => c.d < od - 0.01).map((c) => c.d);
    const bore = inner.length ? Math.min(...inner) : null;
    return {
      type: 'round', subtype: L <= 3 ? 'spacer' : 'shaft', ext, view: order[1], horizontal: a, vertical: order[2],
      length: L, od, bore, warnings,
    };
  }

  if (!biggest || axisOf(biggest.n) < 0) warnings.push('The part isn\'t square to the Part Studio axes, so the views may be at an angle.');
  return { type: 'other', ext, view: order[2], horizontal: order[0], vertical: order[1], warnings };
}

// ---- 2. views and layout -------------------------------------------------
// Standard Onshape view names, and which model axes end up across and up the
// sheet in each (third-angle). 0 = X, 1 = Y, 2 = Z.
const ORIENTATIONS = {
  2: { name: 'top', across: 0, up: 1 },
  1: { name: 'front', across: 0, up: 2 },
  0: { name: 'right', across: 1, up: 2 },
};

// Sheet: ANSI A landscape (11 x 8.5 in). Keep clear of the notes (top left)
// and the title block (bottom right).
const SHEET = { w: 11, h: 8.5, left: 0.7, right: 10.3, bottom: 2.4, top: 6.9 };
const SCALES = [[2, 1], [1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 8], [1, 10]];

function viewSetup(info) {
  const o = ORIENTATIONS[info.view];
  // Turn the view a quarter turn when the part's long side would run up the sheet.
  const rotation = o.up === info.horizontal ? 90 : 0;
  return { orientation: o.name, rotation };
}

// Picks the biggest scale that fits, and where each view's centre goes.
// Sizes are in inches on the sheet.
function planDrawing(info, { qty = 1, material = '', partNumber = '' } = {}) {
  const W = info.ext[info.horizontal];
  const H = info.ext[info.vertical];
  const D = info.ext[3 - info.horizontal - info.vertical];
  const { orientation, rotation } = viewSetup(info);
  const notes = [`Qty: ${qty} PCS`];
  const roomW = SHEET.right - SHEET.left;
  const roomH = SHEET.top - SHEET.bottom;
  let views = null;
  let scale = SCALES[SCALES.length - 1];

  for (const sc of SCALES) {
    const s = sc[0] / sc[1];
    let fits = false;
    if (info.type === 'plate') {
      // flat view, 1.0" gap, edge view; room for callouts above and dims below
      fits = W * s + 1.2 + D * s + 1.0 <= roomW && H * s + 1.3 <= roomH;
    } else if (info.type === 'tube') {
      const es = endScale(info, s);
      fits = W * s + 1.4 + Math.max(H, D) * es + 0.8 <= roomW
        && H * s + (info.holesOnNarrow ? D * s + 0.9 : 0) + 1.1 <= roomH;
    } else if (info.type === 'round') {
      fits = W * s + 1.2 + H * s + 0.8 <= roomW && H * s + 1.1 <= roomH;
    } else {
      fits = W * s + 1.2 + D * s + 0.8 <= roomW && H * s + 1.0 + D * s + 0.6 <= roomH;
    }
    if (fits) { scale = sc; break; }
  }
  const s = scale[0] / scale[1];
  const custom = (sc) => ({ scaleSource: 'Custom', numerator: sc[0], denumerator: sc[1] });
  const x0 = SHEET.left + 0.6;   // left edge of the main view (room for the height dim)
  const yMid = SHEET.bottom + 0.8 + H * s / 2; // main view sits low, callouts go above
  const main = { key: 'main', x: x0 + W * s / 2, y: yMid };

  if (info.type === 'plate') {
    notes.push(`Material: ${material || '(not set)'}`);
    const n64 = Math.round(info.thickness * 64);
    let thick = fmt(info.thickness);
    if (n64 && Math.abs(info.thickness - n64 / 64) < 0.0006) thick += ` (${frac(n64 / 64, 64)})`;
    notes.push(`Thickness: ${thick}`);
    views = [
      main,
      { key: 'edge', parent: 'main', x: main.x + W * s / 2 + 1.0 + D * s / 2, y: yMid },
      iso(s, main.x + W * s / 2 + 1.6 + D * s),
    ];
  } else if (info.type === 'tube') {
    notes.push(`Material: ${info.material}`);
    notes.push(sawNote(info.length));
    if (info.extraHoles.length) notes.push(`Extra holes: ${info.extraHoles.join(', ')} - see DXF`);
    const es = endScale(info, s);
    const endScaleArr = es === s ? null : (es >= 1 ? [es, 1] : [1, Math.round(1 / es)]);
    views = [main];
    if (info.holesOnNarrow) views.push({ key: 'narrow', parent: 'main', x: main.x, y: yMid + H * s / 2 + 0.9 + D * s / 2 });
    views.push({ key: 'end', parent: 'main', x: main.x + W * s / 2 + 1.2 + D * es / 2, y: yMid, scale: endScaleArr && custom(endScaleArr), endScale: es });
  } else if (info.type === 'round') {
    notes.push(`Material: ${material || '(not set)'}`);
    notes.push(sawNote(info.length));
    views = [
      main,
      { key: 'end', parent: 'main', x: main.x + W * s / 2 + 1.0 + H * s / 2, y: yMid },
      iso(s, main.x + W * s / 2 + 1.6 + H * s),
    ];
  } else {
    notes.push(`Material: ${material || '(not set)'}`);
    notes.push('Overall sizes only - add the details by hand');
    views = [
      main,
      { key: 'right', parent: 'main', x: main.x + W * s / 2 + 1.0 + D * s / 2, y: yMid },
      { key: 'above', parent: 'main', x: main.x, y: yMid + H * s / 2 + 0.8 + D * s / 2 },
      iso(s, main.x + W * s / 2 + 1.6 + D * s),
    ];
  }
  return {
    type: info.type,
    partNumber,
    orientation,
    rotation,
    scale,
    s,
    views: views.filter(Boolean),
    notes,
    labels: info.type === 'plate' ? info.holes : [],
    info,
  };

  // Iso view in the top-right corner, in whatever room is left.
  function iso(sMain, left) {
    const avail = SHEET.right - left;
    if (avail < 1.2) return null;
    const size = Math.hypot(W, H, D) || 1;
    const si = Math.min(sMain * 0.9, avail / size, 2.6 / size);
    const sc = SCALES.find(([n, d]) => n / d <= si);
    if (!sc) return null;
    return { key: 'iso', iso: true, x: left + avail / 2, y: SHEET.top - 1.3, scale: custom(sc) };
  }
}

// Tube end views are tiny at 1:4, so they're drawn 1:1 when they fit.
function endScale(info, s) {
  return (s < 1 && Math.max(info.width, info.height) <= 2.2) ? 1 : s;
}

// The onshapeCreateViews request for a plan. reference: { elementId, idTag,
// documentId?, versionId?, configuration? } for the part.
function viewRequests(plan, reference) {
  const out = [];
  for (const v of plan.views) {
    const base = { position: { x: round4(v.x), y: round4(v.y) }, logicalId: `auto_${v.key}` };
    if (v.key === 'main') {
      out.push({
        ...base,
        viewType: 'TopLevel',
        orientation: plan.orientation,
        rotation: plan.rotation,
        scale: { scaleSource: 'Custom', numerator: plan.scale[0], denumerator: plan.scale[1] },
        reference,
        showCentermarks: false,
      });
    } else if (v.iso) {
      out.push({ ...base, viewType: 'TopLevel', orientation: 'isometric', scale: v.scale, reference, showCentermarks: false });
    } else {
      out.push({ ...base, viewType: 'Projected', parentView: { logicalId: `auto_${v.parent}` }, showCentermarks: false, ...(v.scale ? { scale: v.scale } : {}) });
    }
  }
  return out;
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

// ---- 3. annotations from where Onshape drew the edges ---------------------
// views: { key: { viewId, matrix (12 numbers, view -> sheet) } }
// geometry: { key: bodyData array from jsongeometry }
function toPaper(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  ];
}

// Points a dimension can snap to: line ends, and circle/arc quadrants.
function snapPoints(edges, m) {
  const pts = [];
  for (const e of edges || []) {
    if (!e || e.visible === false || !e.data || e.isCenterline) continue;
    const t = String(e.type || '').toLowerCase();
    if (t === 'line') {
      pts.push({ v: e.data.start, id: e.uniqueId, did: e.deterministicId, snap: 'ModeStart' });
      pts.push({ v: e.data.end, id: e.uniqueId, did: e.deterministicId, snap: 'ModeEnd' });
    } else if ((t === 'circle' || t === 'circulararc') && e.data.center) {
      const c = e.data.center; const r = e.data.radius;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const v = [c[0] + dx * r, c[1] + dy * r, c[2]];
        if (t === 'circulararc' && !onArc(e.data, v)) continue;
        pts.push({ v, id: e.uniqueId, did: e.deterministicId, snap: 'ModeQuad' });
      }
      if (t === 'circulararc') {
        pts.push({ v: e.data.start, id: e.uniqueId, did: e.deterministicId, snap: 'ModeStart' });
        pts.push({ v: e.data.end, id: e.uniqueId, did: e.deterministicId, snap: 'ModeEnd' });
      }
    }
  }
  for (const p of pts) p.p = toPaper(m, p.v);
  return pts;
}

// Is point v on the arc (counter-clockwise from start to end around +Z,
// or the other way if the arc's axis points down)?
function onArc(a, v) {
  const ang = (p) => Math.atan2(p[1] - a.center[1], p[0] - a.center[0]);
  const flip = a.axisDir && a.axisDir[2] < 0 ? -1 : 1;
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const s = ang(a.start); const e = ang(a.end); const t = ang(v);
  return flip > 0 ? norm(t - s) <= norm(e - s) + 1e-6 : norm(s - t) <= norm(s - e) + 1e-6;
}

function ref(p, viewId) {
  const out = { type: 'Onshape::Reference::Point', coordinate: p.v, uniqueId: p.id, viewId, snapPointType: p.snap };
  if (p.did) out.deterministicId = p.did;
  return out;
}

function extremes(pts) {
  const by = (f) => pts.reduce((best, p) => (best && f(best) >= f(p) ? best : p), null);
  return {
    left: by((p) => -p.p[0]), right: by((p) => p.p[0]),
    bottom: by((p) => -p.p[1]), top: by((p) => p.p[1]),
  };
}

function p2p(a, b, viewId, textAt, horizontal) {
  return {
    type: 'Onshape::Dimension::PointToPoint',
    pointToPointDimension: {
      point1: ref(a, viewId),
      point2: ref(b, viewId),
      rotation: horizontal ? 0 : 90,
      textPosition: { type: 'Onshape::Reference::Point', coordinate: [round4(textAt[0]), round4(textAt[1]), 0] },
    },
  };
}

function note(text, at, height = 0.12, leader = null) {
  const n = { position: { type: 'Onshape::Reference::Point', coordinate: [round4(at[0]), round4(at[1]), 0] }, contents: text, textHeight: height };
  if (leader) n.leaderPosition = leader;
  return { type: 'Onshape::Note', note: n };
}

function box(pts) {
  const xs = pts.map((p) => p.p[0]); const ys = pts.map((p) => p.p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// Overall width (below) and height (left) of a view.
function overallDims(pts, viewId, { width = true, height = true, below = 0.45, left = 0.45 } = {}) {
  const out = [];
  if (!pts.length) return out;
  const ex = extremes(pts);
  const b = box(pts);
  if (width && b.x1 - b.x0 > 0.05) out.push(p2p(ex.left, ex.right, viewId, [(b.x0 + b.x1) / 2, b.y0 - below], true));
  if (height && b.y1 - b.y0 > 0.05) out.push(p2p(ex.bottom, ex.top, viewId, [b.x0 - left, (b.y0 + b.y1) / 2], false));
  return out;
}

function circlesOf(edges, m) {
  return (edges || [])
    .filter((e) => e && e.visible !== false && String(e.type || '').toLowerCase() === 'circle' && e.data && e.data.center)
    .map((e) => ({ e, c: toPaper(m, e.data.center), dIn: (2 * e.data.radius) / IN }));
}

function annotationsFor(plan, views, geometry) {
  const out = [];
  const warnings = [];
  // Notes in the top-left corner, one line each.
  plan.notes.forEach((text, i) => out.push(note(text, [0.75, 7.75 - i * 0.2], 0.12)));

  const main = views.main;
  if (!main) return { annotations: out, warnings: ['The main view wasn\'t found, so only the notes were added.'] };
  const mainPts = snapPoints(geometry.main, main.matrix);
  const mb = mainPts.length ? box(mainPts) : null;

  if (plan.type === 'plate') {
    out.push(...overallDims(mainPts, main.viewId));
    // One callout per hole size, above the view, each leader to the hole of
    // that size nearest the top edge. Labels step up a row when they'd overlap.
    const circles = circlesOf(geometry.main, main.matrix);
    const used = [];
    let row = 0;
    const placed = [];
    for (const h of plan.labels) {
      const same = circles.filter((c) => Math.abs(c.dIn - h.d) < 0.0015 && !used.includes(c));
      if (!same.length) { warnings.push(`Couldn't find the ${h.label} holes in the view to call them out.`); continue; }
      const target = same.sort((a, b) => b.c[1] - a.c[1])[0];
      used.push(target);
      const width = 0.09 * h.label.length + 0.2;
      let x = Math.min(Math.max(target.c[0] + 0.25, SHEET.left), SHEET.right - width);
      let y = (mb ? mb.y1 : target.c[1]) + 0.4;
      while (placed.some((p) => Math.abs(p.y - y) < 0.2 && x < p.x + p.w && p.x < x + width)) { row += 1; y += 0.25; }
      placed.push({ x, y, w: width });
      const r = target.e.data.radius;
      const onCircle = [target.e.data.center[0], target.e.data.center[1] + r, target.e.data.center[2]];
      out.push(note(h.label, [x, y], 0.12, {
        type: 'Onshape::Reference::Point', coordinate: onCircle, uniqueId: target.e.uniqueId,
        ...(target.e.deterministicId ? { deterministicId: target.e.deterministicId } : {}),
        viewId: main.viewId, snapPointType: 'ModeNear',
      }));
    }
    const edge = views.edge;
    if (edge) {
      const ePts = snapPoints(geometry.edge, edge.matrix);
      if (ePts.length) {
        const ex = extremes(ePts); const eb = box(ePts);
        out.push(p2p(ex.left, ex.right, edge.viewId, [(eb.x0 + eb.x1) / 2, eb.y1 + 0.35], true));
      }
    }
  } else if (plan.type === 'tube') {
    out.push(...overallDims(mainPts, main.viewId, { height: false }));
    // First hole: from the left end of the tube to the nearest hole centre.
    const circles = circlesOf(geometry.main, main.matrix).sort((a, b) => a.c[0] - b.c[0]);
    if (circles.length && mb) {
      const ex = extremes(mainPts);
      const first = circles[0];
      out.push(p2p(ex.left, { v: first.e.data.center, id: first.e.uniqueId, did: first.e.deterministicId, snap: 'ModeCenter', p: first.c },
        main.viewId, [(mb.x0 + first.c[0]) / 2, mb.y1 + 0.35], true));
    }
    const end = views.end;
    if (end) {
      const ePts = snapPoints(geometry.end, end.matrix);
      out.push(...overallDims(ePts, end.viewId, { below: 0.4, left: 0.4 }));
      // Wall: outer left edge to the next vertical line in.
      const verticals = ePts.filter((p) => p.snap === 'ModeStart').map((p) => p.p[0]);
      const eb = ePts.length ? box(ePts) : null;
      if (eb && plan.info.wall) {
        const outerLeft = extremes(ePts).left;
        const inner = ePts.filter((p) => p.p[0] > eb.x0 + 0.01 && p.p[0] < (eb.x0 + eb.x1) / 2)
          .sort((a, b) => a.p[0] - b.p[0])[0];
        if (inner) out.push(p2p(outerLeft, inner, end.viewId, [eb.x0 - 0.35, eb.y1 + 0.3], true));
      }
      if (!verticals.length) warnings.push('Couldn\'t find the tube end view edges for W, H and wall.');
    }
  } else if (plan.type === 'round') {
    out.push(...overallDims(mainPts, main.viewId, { height: false }));
    const end = views.end;
    if (end) {
      const circles = circlesOf(geometry.end, end.matrix).sort((a, b) => b.dIn - a.dIn);
      const eb = circles.length ? { x1: Math.max(...circles.map((c) => c.c[0] + c.dIn * plan.s / 2)) } : null;
      circles.slice(0, 2).forEach((c, i) => {
        const label = i === 0 ? `Ø${fmt(c.dIn)}` : holeLabel(c.dIn, 1);
        const at = [eb.x1 + 0.3, c.c[1] + 0.5 - i * 0.3];
        const r = c.e.data.radius;
        out.push(note(label, at, 0.12, {
          type: 'Onshape::Reference::Point', coordinate: [c.e.data.center[0] + r * 0.7071, c.e.data.center[1] + r * 0.7071, c.e.data.center[2]],
          uniqueId: c.e.uniqueId, ...(c.e.deterministicId ? { deterministicId: c.e.deterministicId } : {}), viewId: end.viewId, snapPointType: 'ModeNear',
        }));
      });
      if (!circles.length) warnings.push('Couldn\'t find the round edges in the end view for the OD and bore.');
    }
  } else {
    out.push(...overallDims(mainPts, main.viewId));
    const right = views.right;
    if (right) out.push(...overallDims(snapPoints(geometry.right, right.matrix), right.viewId, { height: false }));
  }
  return { annotations: out, warnings };
}

// ---- Onshape calls -------------------------------------------------------
// api(path, options) is the server's onshapeFetch bound to the request.
async function waitForModify(api, id, what) {
  const deadline = Date.now() + 90 * 1000;
  let st = { requestState: 'ACTIVE' };
  let delay = 700;
  while (st.requestState === 'ACTIVE') {
    if (Date.now() > deadline) throw new Error(`Onshape took too long to ${what}.`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 3000);
    st = await api(`/drawings/modify/status/${id}`);
  }
  if (st.requestState !== 'DONE') throw new Error(`Onshape couldn't ${what}${st.failureReason ? `: ${st.failureReason}` : '.'}`);
  let output = {};
  try { output = typeof st.output === 'string' ? JSON.parse(st.output) : (st.output || {}); } catch (err) { /* keep {} */ }
  return output;
}

async function modify(api, ctx, eid, description, jsonRequest, what) {
  const started = await api(`/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${eid}/modify`, {
    method: 'POST',
    body: JSON.stringify({ description: description.slice(0, 32), jsonRequests: [{ formatVersion: '2021-01-01', ...jsonRequest }] }),
  });
  return waitForModify(api, started.id, what);
}

function failures(output) {
  return (output.results || []).filter((r) => r.status && !/ok|success/i.test(r.status))
    .map((r) => r.errorDescription || r.status);
}

// Creates the drawing tab. Tries the team's preferred sheet (ANSI A, inches,
// third angle, with title block and border) and falls back to the account's
// defaults if Onshape doesn't take those settings.
async function createDrawingElement(api, ctx, name) {
  const path = `/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/create`;
  const preferred = {
    drawingName: name, views: 'zero', standard: 'ANSI', units: 'inch', size: 'A',
    projection: 'third', titleblock: true, border: true,
  };
  try {
    return await api(path, { method: 'POST', body: JSON.stringify(preferred) });
  } catch (err) {
    if (err.status !== 400) throw err;
    return api(path, { method: 'POST', body: JSON.stringify({ drawingName: name, views: 'zero' }) });
  }
}

// Lists the drawing's views with their view -> sheet matrices. Onshape's
// /views endpoint is tried first; the full drawing JSON export is the fallback.
async function readViews(api, ctx, eid, exportJson) {
  let list = [];
  try {
    const r = await api(`/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${eid}/views`);
    list = Array.isArray(r) ? r : (r.items || r.views || []);
  } catch (err) { /* fall back below */ }
  if (!list.length || !list.some((v) => v.viewToPaperMatrix)) {
    const json = await exportJson();
    list = [];
    for (const sheet of json.sheets || []) list.push(...(sheet.views || []));
  }
  return list.map((v) => ({
    viewId: v.viewId,
    logicalId: v.logicalId,
    position: v.position || {},
    matrix: (v.viewToPaperMatrix && (v.viewToPaperMatrix.items || v.viewToPaperMatrix)) || null,
  }));
}

// Matches our planned views to Onshape's by logical id, else by position.
function matchViews(plan, list, created) {
  const out = {};
  const free = list.slice();
  plan.views.forEach((v, i) => {
    const want = created[i] && created[i].logicalId;
    let hit = free.find((x) => want && (x.logicalId === want || x.viewId === want));
    if (!hit) {
      hit = free.slice().sort((a, b) => Math.hypot(a.position.x - v.x, a.position.y - v.y) - Math.hypot(b.position.x - v.x, b.position.y - v.y))[0];
    }
    if (hit && hit.matrix) {
      out[v.key] = hit;
      free.splice(free.indexOf(hit), 1);
    }
  });
  return out;
}

async function viewGeometry(api, ctx, eid, viewId) {
  try {
    const r = await api(`/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${eid}/views/${viewId}/jsongeometry`);
    return r.bodyData || [];
  } catch (err) {
    const r = await api(`/appelements/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${eid}/views/${viewId}/jsongeometry`);
    return r.bodyData || [];
  }
}

// The whole job. Returns { drawingId, name, plan, warnings }.
async function makeDrawing({ api, ctx, reference, body, box, name, partNumber, qty, material, exportJson }) {
  const info = analyzePart(body, box);
  const plan = planDrawing(info, { qty, material, partNumber });
  const warnings = [...info.warnings];

  const created = await createDrawingElement(api, ctx, name);
  const eid = created.id || created.elementId || (created.element && created.element.id);
  if (!eid) throw new Error('Onshape made the drawing but didn\'t say which tab it is.');

  const requests = viewRequests(plan, reference);
  const viewOut = await modify(api, ctx, eid, 'Add views', { messageName: 'onshapeCreateViews', views: requests }, 'add the views');
  const viewFails = failures(viewOut);
  if (viewFails.length) warnings.push(`Some views weren't added: ${viewFails.join('; ')}`);
  const createdIds = (viewOut.results || []).map((r) => ({ logicalId: r.logicalId }));

  let views = {};
  try {
    views = matchViews(plan, await readViews(api, ctx, eid, () => exportJson(eid)), createdIds);
  } catch (err) {
    warnings.push('Couldn\'t read the views back, so only the notes were added.');
  }
  const geometry = {};
  for (const [key, v] of Object.entries(views)) {
    try { geometry[key] = await viewGeometry(api, ctx, eid, v.viewId); } catch (err) { geometry[key] = []; }
  }
  const { annotations, warnings: annWarnings } = annotationsFor(plan, views, geometry);
  warnings.push(...annWarnings);
  if (annotations.length) {
    try {
      const out = await modify(api, ctx, eid, 'Add dims and notes', { messageName: 'onshapeCreateAnnotations', annotations }, 'add the dimensions and notes');
      const fails = failures(out);
      if (fails.length) warnings.push(`${fails.length} of ${annotations.length} notes/dimensions weren't added: ${[...new Set(fails)].slice(0, 3).join('; ')}`);
    } catch (err) {
      warnings.push(err.message);
    }
  }
  return { drawingId: eid, name, plan: { type: plan.type, scale: plan.scale, orientation: plan.orientation }, warnings };
}

module.exports = {
  analyzePart, planDrawing, viewRequests, annotationsFor, makeDrawing,
  sawNote, holeLabel, fmt, frac, matchViews,
};
