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
//   hex     hex shafts (plain or rounded, snap rings fused on or not) side
//           view with the overall length, the effective length between the
//           snap rings + "View Snap Ring Standard", across flats; end view
//           with the tapped hole; notes: Qty, Material, Stock, saw cut
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

const { squareUp, squaredCopy, tiltDegrees } = require('./square-up');

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

  const hex = hexShaft({ planes, coaxial, a, L, ext, cross, low, high, axisOf });
  if (hex) return { ...hex, ext, warnings: [...warnings, ...hex.warnings] };

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

// Hex shaft (plain or rounded hex, like the FRC Design App shafts), with or
// without snap ring grooves. Returns null when the part isn't one.
//   across     size across the flats (.500 for 1/2" hex)
//   effective  length between the snap rings: from the inside wall of the
//              groove near one end to the inside wall of the groove near the
//              other end (Micah: shafts are drawn with the overall length,
//              the effective length and a "View Snap Ring Standard" note)
// FRC Design App shafts can come in as one body with the snap rings fused
// on, so the snap ring's own faces are bigger than the hex. Sizes are taken
// from the hex flats, never from the overall box, so the ring's OD is never
// mistaken for the shaft size.
function hexShaft({ planes, coaxial, a, L, ext, cross, low, high, axisOf }) {
  const minCross = Math.min(ext[cross[0]], ext[cross[1]]);
  if (L < 1.5 * minCross) return null;
  // Faces running along the shaft. The hex flats are the long ones; a snap
  // ring's ear faces are small, so they're left out.
  const along = planes.filter((p) => Math.abs(p.n[a]) < 1e-3);
  if (!along.length) return null;
  const maxArea = Math.max(...along.map((p) => p.area));
  const big = along.filter((p) => p.area > 0.4 * maxArea);
  const dirs = [];
  for (const p of big) {
    const d = dirs.find((x) => Math.abs(dot(x.n, p.n)) > 0.999);
    if (d) d.faces.push(p); else dirs.push({ n: p.n, faces: [p] });
  }
  if (dirs.length !== 3 || dirs.some((d) => d.faces.length < 2)) return null;
  // Hex flats are 60 degrees apart.
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) if (Math.abs(Math.abs(dot(dirs[i].n, dirs[j].n)) - 0.5) > 0.01) return null;
  }
  const widths = dirs.map((d) => {
    const pos = d.faces.map((p) => dot(p.o, d.n) / IN);
    return Math.max(...pos) - Math.min(...pos);
  });
  const across = widths.reduce((s, w) => s + w, 0) / 3;
  // A hex-bore spacer's flats are inside a round outside; a shaft's flats
  // are its outside (only a snap ring or the corners stick out past them).
  if (across < 0.8 * minCross || widths.some((w) => Math.abs(w - across) > 0.01)) return null;

  const warnings = [];
  const rounded = coaxial.some((c) => c.d > across + 0.005 && c.d < across * 1.16);
  // The hole in the end sits on the shaft's centreline (a fused snap ring's
  // ear holes point the same way but are off to the side).
  const centre = dirs.map((d) => {
    const pos = d.faces.map((p) => dot(p.o, d.n) / IN);
    return (Math.max(...pos) + Math.min(...pos)) / 2;
  });
  const onAxis = (c) => dirs.every((d, i) => Math.abs(dot(c.o, d.n) / IN - centre[i]) < 0.01);
  const holes = coaxial.filter((c) => c.d < 0.7 * across && onAxis(c)).map((c) => c.d);
  const bore = holes.length ? Math.min(...holes) : null;

  // Snap ring grooves: round faces a bit smaller than the hex, and the
  // groove walls (flat faces across the shaft, not the two ends). Walls
  // close together belong to one groove (and a fused snap ring's sides).
  // The effective length runs between the inside walls of the grooves
  // nearest each end, wherever along the shaft they are: a gearbox shaft's
  // rings can sit well in from the ends, next to a bearing.
  const sMin = low[a]; const sMax = high[a];
  const grooves = coaxial.filter((c) => c.d >= 0.7 * across && c.d < across - 0.005);
  const walls = planes.filter((p) => Math.abs(Math.abs(p.n[a]) - 1) < 1e-3).map((p) => p.o[a] / IN)
    .filter((s) => s > sMin + 0.005 && s < sMax - 0.005).sort((x, y) => x - y);
  const clusters = [];
  for (const w of walls) {
    const last = clusters[clusters.length - 1];
    if (last && w - last[last.length - 1] < 0.15) last.push(w); else clusters.push([w]);
  }
  let effective = null;
  let ringOffsets = null;
  if (grooves.length && clusters.length >= 2) {
    const lo = Math.max(...clusters[0]); const hi = Math.min(...clusters[clusters.length - 1]);
    effective = hi - lo;
    ringOffsets = [lo - sMin, sMax - hi];
  } else if (grooves.length) {
    warnings.push('Found a snap ring groove but not one near each end, so there\'s no effective length.');
  }

  // Side view with flats on the top and bottom, so its height is the size
  // across the flats.
  const flatAxis = dirs.map((d) => axisOf(d.n)).find((i) => i >= 0 && i !== a);
  let view; let vertical;
  if (flatAxis !== undefined) {
    vertical = flatAxis;
    view = 3 - a - flatAxis;
  } else {
    [view, vertical] = cross;
    warnings.push('The hex flats aren\'t square to the Part Studio axes, so the across-flats size isn\'t dimensioned.');
  }
  return {
    type: 'hex', subtype: 'shaft', view, horizontal: a, vertical, flatsSquare: flatAxis !== undefined,
    length: L, across, rounded, bore, effective, ringOffsets, warnings,
  };
}

// 0.5 -> 1/2" hex, 0.375 -> 3/8" rounded hex
function hexStock(info) {
  const n16 = Math.round(info.across * 16);
  const size = Math.abs(info.across - n16 / 16) < 0.003 ? frac(n16 / 16) : `${fmt(info.across)}"`;
  return `${size} ${info.rounded ? 'rounded hex' : 'hex'}`;
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
function planDrawing(info, { qty = 1, material = '', partNumber = '', partName = '', smallerThan = null } = {}) {
  const W = info.ext[info.horizontal];
  const H = info.ext[info.vertical];
  const D = info.ext[3 - info.horizontal - info.vertical];
  const { orientation, rotation } = viewSetup(info);
  // The part number and name go in the title block (the part's own
  // properties, filled by the server), not in these notes.
  const notes = [`Qty: ${qty} PCS`];
  const roomW = SHEET.right - SHEET.left;
  const roomH = SHEET.top - SHEET.bottom;
  let views = null;
  let scale = (smallerThan && SCALES.find((sc) => sc[0] / sc[1] < smallerThan[0] / smallerThan[1])) || SCALES[SCALES.length - 1];

  for (const sc of SCALES) {
    if (smallerThan && sc[0] / sc[1] >= smallerThan[0] / smallerThan[1]) continue;
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
    } else if (info.type === 'hex') {
      // across-flats dim on the right, effective length + snap ring note above
      fits = W * s + 1.9 + H * s + 0.8 <= roomW && H * s + 1.1 + (info.effective ? 1.4 : 0) <= roomH;
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
  } else if (info.type === 'hex') {
    notes.push(`Material: ${material || '(not set)'}`);
    notes.push(`Stock: ${hexStock(info)}`);
    notes.push(sawNote(info.length));
    views = [
      main,
      { key: 'end', parent: 'main', x: main.x + W * s / 2 + 1.7 + H * s / 2, y: yMid },
      iso(s, main.x + W * s / 2 + 2.3 + H * s),
    ];
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

// Round edges in a view, one entry per circle. A hole can come back as one
// full circle or as two half arcs, so arcs with the same centre and radius
// are grouped into one entry (edges lists them all).
function circlesOf(edges, m) {
  const out = [];
  for (const e of edges || []) {
    const t = String((e && e.type) || '').toLowerCase();
    if (!e || e.visible === false || !e.data || !e.data.center || (t !== 'circle' && t !== 'circulararc')) continue;
    const c = toPaper(m, e.data.center);
    const same = out.find((o) => Math.abs(o.e.data.radius - e.data.radius) < 1e-7 && Math.hypot(o.c[0] - c[0], o.c[1] - c[1]) < 1e-4);
    if (same) { same.edges.push(e); if (t === 'circle') same.e = e; continue; }
    out.push({ e, edges: [e], c, dIn: (2 * e.data.radius) / IN });
  }
  // Only whole (or nearly whole) holes: two halves, or a full circle.
  return out.filter((o) => o.edges.some((e) => String(e.type).toLowerCase() === 'circle') || o.edges.length >= 2);
}

// ---- overlap checks ------------------------------------------------------
// Everything placed on the sheet is tracked here in sheet inches: the part's
// edges, dimension lines and text, note boxes and leaders. A label is only
// put where its box and leader stay clear of everything already there, the
// same rules the PDF prototype used:
//   - text never sits on a line or on other text
//   - leaders don't cross other leaders or run through text
//   - a leader crosses as few of the part's edges as it can (1 = just the
//     outline; a short hop over a pocket edge is allowed when there's no
//     cleaner spot)
//   - nothing runs into the notes, the title block or off the sheet
const TITLE = { x0: 4.35, y0: 0.35, x1: 10.65, y1: 2.05 };
const CHAR_W = 0.095;  // sheet inches per character at 0.12" text
const TEXT_H = 0.12;
const NBSP = ' ';  // so Onshape doesn't wrap "14x Ø.200" onto two lines
const keepWhole = (s) => String(s).replace(/ /g, NBSP);

function segCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function boxesHit(a, b, pad = 0) {
  return !(a.x1 + pad < b.x0 || b.x1 + pad < a.x0 || a.y1 + pad < b.y0 || b.y1 + pad < a.y0);
}
// Does segment p-q touch box b (grown by pad)? Liang-Barsky clipping.
function segHitsBox(p, q, b, pad = 0) {
  const x0 = b.x0 - pad; const y0 = b.y0 - pad; const x1 = b.x1 + pad; const y1 = b.y1 + pad;
  const dx = q[0] - p[0]; const dy = q[1] - p[1];
  let t0 = 0; let t1 = 1;
  for (const [pp, qq] of [[-dx, p[0] - x0], [dx, x1 - p[0]], [-dy, p[1] - y0], [dy, y1 - p[1]]]) {
    if (pp === 0) { if (qq < 0) return false; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

// The part's visible edges in one view as straight segments on the sheet.
function viewSegments(edges, m) {
  const segs = [];
  for (const e of edges || []) {
    if (!e || e.visible === false || !e.data || e.isCenterline) continue;
    const t = String(e.type || '').toLowerCase();
    const id = e.uniqueId;
    if (t === 'line') segs.push({ a: toPaper(m, e.data.start), b: toPaper(m, e.data.end), id });
    else if ((t === 'circle' || t === 'circulararc') && e.data.center) {
      const c = e.data.center; const r = e.data.radius;
      let pts = [];
      for (let k = 0; k <= 24; k += 1) {
        const ang = (k / 24) * 2 * Math.PI;
        const v = [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang), c[2]];
        if (t === 'circle' || onArc(e.data, v)) pts.push(toPaper(m, v)); else if (pts.length) { addPolyline(segs, pts, id); pts = []; }
      }
      addPolyline(segs, pts, id);
    } else {
      const pts = (e.data.points || []).map((p) => toPaper(m, p));
      if (pts.length < 2 && e.data.start && e.data.end) pts.push(toPaper(m, e.data.start), toPaper(m, e.data.end));
      addPolyline(segs, pts, id);
    }
  }
  return segs;
}
function addPolyline(segs, pts, id) {
  for (let i = 1; i < pts.length; i += 1) segs.push({ a: pts[i - 1], b: pts[i], id });
}

class Layout {
  constructor(noteBox) {
    this.edges = [];       // part edges (all views)
    this.lines = [];       // dimension and leader lines
    this.boxes = [];       // text boxes (labels, dim text, notes)
    this.viewBoxes = {};
    this.issues = [];
    this.keepOut = [TITLE, noteBox];
  }
  addView(key, segs) {
    this.edges.push(...segs.map((s) => ({ ...s, view: key })));
    if (segs.length) {
      const xs = segs.flatMap((s) => [s.a[0], s.b[0]]); const ys = segs.flatMap((s) => [s.a[1], s.b[1]]);
      this.viewBoxes[key] = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
  }
  // Space a dimension takes: its line, its extension lines, and its text.
  addDim(a, b, textAt, horizontal, text) {
    const w = CHAR_W * text.length + 0.1;
    const tb = { x0: textAt[0] - w / 2, y0: textAt[1] - 0.09, x1: textAt[0] + w / 2, y1: textAt[1] + 0.09 };
    if (horizontal) {
      this.lines.push({ a: [a[0], textAt[1]], b: [b[0], textAt[1]] }, { a: [a[0], a[1]], b: [a[0], textAt[1]] }, { a: [b[0], b[1]], b: [b[0], textAt[1]] });
    } else {
      this.lines.push({ a: [textAt[0], a[1]], b: [textAt[0], b[1]] }, { a: [a[0], a[1]], b: [textAt[0], a[1]] }, { a: [b[0], b[1]], b: [textAt[0], b[1]] });
    }
    this.boxes.push(tb);
  }
  inSheet(b) { return b.x0 >= SHEET.left - 0.2 && b.x1 <= SHEET.right + 0.2 && b.y0 >= 0.6 && b.y1 <= 7.9; }
  // Can a label box go here, with a leader from tail to tip (sheet coords)?
  // Returns how many part edges the leader crosses, or -1 if it can't.
  fits(b, tail, tip, ownId) {
    if (!this.inSheet(b)) return -1;
    if (this.keepOut.some((k) => k && boxesHit(b, k, 0.05))) return -1;
    if (this.boxes.some((k) => boxesHit(b, k, 0.06))) return -1;
    if (this.edges.some((s) => segHitsBox(s.a, s.b, b, 0.05))) return -1;
    if (this.lines.some((s) => segHitsBox(s.a, s.b, b, 0.03))) return -1;
    if (tail) {
      if (this.lines.some((s) => segCross(tail, tip, s.a, s.b))) return -1;
      if (this.boxes.some((k) => segHitsBox(tail, tip, k, 0.02))) return -1;
      return this.edges.filter((s) => s.id !== ownId && segCross(tail, tip, s.a, s.b)).length;
    }
    return 0;
  }
  addLabel(b, tail, tip) {
    this.boxes.push(b);
    if (tail) this.lines.push({ a: tail, b: tip });
  }
}

// Is a sheet point on the part's material in a view (inside an odd number of
// outlines)? Used to keep labels in open gaps, never on the part.
function onMaterial(pt, segs) {
  const far = [pt[0] + 50, pt[1] + 0.000123];
  return segs.filter((s) => segCross(pt, far, s.a, s.b)).length % 2 === 1;
}

// Finds a clean spot for a leader note pointing at one of `targets` (circles
// with sheet centre c and edge e). Tries spots above, below, left and right
// of the view, then in open gaps inside it, nearest first.
function placeLeaderNote(layout, viewKey, viewId, targets, label, m) {
  const vb = layout.viewBoxes[viewKey];
  if (!vb) return null;
  const viewSegs = layout.edges.filter((s) => s.view === viewKey);
  const w = CHAR_W * label.length + 0.12;
  const scale = Math.hypot(m[0], m[4]) || 1;  // sheet inches per view unit
  let best = null;
  for (const t of targets.slice(0, 12)) {
    const [hx, hy] = t.c;
    const rr = t.e.data.radius * scale;
    for (const off of [0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.2, -0.3, -0.6, -0.9, -1.2]) {
      for (const dx of [0, 0.6, -0.6, 1.2, -1.2, 2.0, -2.0]) {
        for (const side of ['T', 'B', 'R', 'L', 'N', 'S']) {
          if ((side === 'L' || side === 'R') && dx) continue;
          let tx; let ty;
          if (side === 'T') { tx = hx + 0.3 + dx; ty = vb.y1 + 0.35 + Math.max(off, 0); }
          else if (side === 'B') { tx = hx + 0.3 + dx; ty = vb.y0 - 0.35 - Math.max(off, 0); }
          else if (side === 'R') { tx = vb.x1 + 0.35; ty = hy + 0.35 + off; }
          else if (side === 'L') { tx = vb.x0 - 0.35; ty = hy + 0.35 + off; }
          else if (side === 'N') { tx = hx + 0.3 + dx / 2; ty = hy + 0.6 + Math.abs(off); }
          else { tx = hx + 0.3 + dx / 2; ty = hy - 0.6 - Math.abs(off); }
          const left = side === 'L';
          const b = left ? { x0: tx - w, y0: ty - 0.1, x1: tx, y1: ty + 0.1 } : { x0: tx, y0: ty - 0.1, x1: tx + w, y1: ty + 0.1 };
          if (side === 'N' || side === 'S') {
            if (onMaterial([(b.x0 + b.x1) / 2, ty], viewSegs)) continue;
          } else if (boxesHit(b, vb, 0.05)) continue;
          const L = Math.hypot(tx - hx, ty - hy) || 1;
          const tip = [hx + ((tx - hx) / L) * rr, hy + ((ty - hy) / L) * rr];
          const crossings = layout.fits(b, [tx, ty], tip, t.e.uniqueId);
          if (crossings < 0 || crossings > 7) continue;
          const cost = L + (crossings > 1 ? 3 * (crossings - 1) : 0);
          if (!best || cost < best.cost) best = { cost, b, tx, ty, tip, t, left, L };
        }
      }
    }
    if (best && best.cost < 3) break;
  }
  if (!best) return null;
  layout.addLabel(best.b, [best.tx, best.ty], best.tip);
  // The leader lands on the circle on the side facing the label.
  const inv = invDir(m, [(best.tx - best.t.c[0]) / best.L, (best.ty - best.t.c[1]) / best.L]);
  const c0 = best.t.e.data.center; const r0 = best.t.e.data.radius;
  const landing = [c0[0] + inv[0] * r0, c0[1] + inv[1] * r0, c0[2]];
  const e = (best.t.edges || [best.t.e]).find((x) => String(x.type).toLowerCase() === 'circle' || onArc(x.data, landing)) || best.t.e;
  const c = e.data.center; const r = e.data.radius;
  const pos = best.left ? [best.b.x0, best.ty] : [best.b.x0, best.ty];
  return note(label, pos, TEXT_H, {
    type: 'Onshape::Reference::Point', coordinate: [c[0] + inv[0] * r, c[1] + inv[1] * r, c[2]],
    uniqueId: e.uniqueId, ...(e.deterministicId ? { deterministicId: e.deterministicId } : {}),
    viewId, snapPointType: 'ModeNear',
  });
}

// A sheet direction turned back into the view's own x/y directions.
function invDir(m, d) {
  const v = [m[0] * d[0] + m[4] * d[1], m[1] * d[0] + m[5] * d[1]];
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

function annotationsFor(plan, views, geometry) {
  const out = [];
  const warnings = [];
  // Notes in the top-left corner, one line each, never wrapped.
  const noteLines = plan.notes.length;
  const noteW = Math.max(...plan.notes.map((t) => t.length)) * CHAR_W + 0.2;
  const noteBox = { x0: 0.6, y0: 7.75 - (noteLines - 1) * 0.25 - 0.15, x1: 0.75 + noteW, y1: 7.95 };
  plan.notes.forEach((text, i) => out.push(note(keepWhole(text), [0.75, 7.75 - i * 0.25], TEXT_H)));
  const layout = new Layout(noteBox);
  for (const [key, v] of Object.entries(views)) layout.addView(key, viewSegments(geometry[key], v.matrix));

  // Views overlapping each other or the notes / title block.
  const keys = Object.keys(layout.viewBoxes);
  keys.forEach((k, i) => {
    const b = layout.viewBoxes[k];
    if (boxesHit(b, TITLE, 0.05)) layout.issues.push(`the ${k} view runs into the title block`);
    if (boxesHit(b, noteBox, 0.05)) layout.issues.push(`the ${k} view runs into the notes`);
    for (const k2 of keys.slice(i + 1)) if (boxesHit(b, layout.viewBoxes[k2], 0.1)) layout.issues.push(`the ${k} and ${k2} views overlap`);
  });

  const main = views.main;
  if (!main) return { annotations: out, warnings: ['The main view wasn\'t found, so only the notes were added.'] };
  const mainPts = snapPoints(geometry.main, main.matrix);
  const mb = mainPts.length ? box(mainPts) : null;

  // A dimension, registered with the layout so labels keep clear of it.
  const dim = (a, b, viewId, textAt, horizontal) => {
    const len = horizontal ? Math.abs(b.p[0] - a.p[0]) : Math.abs(b.p[1] - a.p[1]);
    layout.addDim(a.p, b.p, textAt, horizontal, fmt(len / 1)); // text length only matters roughly
    out.push(p2p(a, b, viewId, textAt, horizontal));
  };
  const overall = (pts, viewId, { width = true, height = true, below = 0.45, leftGap = 0.45 } = {}) => {
    if (!pts.length) return;
    const ex = extremes(pts); const b = box(pts);
    if (width && b.x1 - b.x0 > 0.05) dim(ex.left, ex.right, viewId, [(b.x0 + b.x1) / 2, b.y0 - below], true);
    if (height && b.y1 - b.y0 > 0.05) dim(ex.bottom, ex.top, viewId, [b.x0 - leftGap, (b.y0 + b.y1) / 2], false);
  };
  // Small dimensions (a thickness, a wall) put their text beside the arrows.
  const smallDim = (a, b, viewId, y, horizontal = true) => {
    const right = Math.max(a.p[0], b.p[0]);
    dim(a, b, viewId, [right + 0.25 + CHAR_W * 2.5, y], horizontal);
  };
  const leaderNote = (viewKey, targets, label) => {
    const v = views[viewKey];
    const n = placeLeaderNote(layout, viewKey, v.viewId, targets, keepWhole(label), v.matrix);
    if (n) out.push(n); else layout.issues.push(`no clean spot for the "${label}" callout`);
    return n;
  };

  if (plan.type === 'plate') {
    overall(mainPts, main.viewId);
    const edge = views.edge;
    if (edge) {
      const ePts = snapPoints(geometry.edge, edge.matrix);
      if (ePts.length) {
        const ex = extremes(ePts); const eb = box(ePts);
        smallDim(ex.left, ex.right, edge.viewId, eb.y1 + 0.3);
      }
    }
    // One callout per hole size, beside one hole of that size.
    const circles = circlesOf(geometry.main, main.matrix);
    for (const h of plan.labels) {
      const same = circles.filter((c) => Math.abs(c.dIn - h.d) < 0.0015);
      if (!same.length) { warnings.push(`Couldn't find the ${h.label} holes in the view to call them out.`); continue; }
      // Holes near the outside first: shortest leaders.
      same.sort((a, b) => edgeGap(a.c, mb) - edgeGap(b.c, mb));
      leaderNote('main', same, h.label);
    }
  } else if (plan.type === 'tube') {
    overall(mainPts, main.viewId, { height: false });
    const circles = circlesOf(geometry.main, main.matrix).sort((a, b) => a.c[0] - b.c[0]);
    if (circles.length && mb) {
      const ex = extremes(mainPts);
      const first = circles[0];
      dim(ex.left, { v: first.e.data.center, id: first.e.uniqueId, did: first.e.deterministicId, snap: 'ModeCenter', p: first.c },
        main.viewId, [Math.min((mb.x0 + first.c[0]) / 2, mb.x0 + 0.3) , mb.y1 + 0.35], true);
    }
    const end = views.end;
    if (end) {
      const ePts = snapPoints(geometry.end, end.matrix);
      overall(ePts, end.viewId, { below: 0.4, leftGap: 0.4 });
      const eb = ePts.length ? box(ePts) : null;
      if (eb && plan.info.wall) {
        const outerLeft = extremes(ePts).left;
        const inner = ePts.filter((p) => p.p[0] > eb.x0 + 0.01 && p.p[0] < (eb.x0 + eb.x1) / 2)
          .sort((a, b) => a.p[0] - b.p[0])[0];
        if (inner) dim(outerLeft, inner, end.viewId, [eb.x1 + 0.45, eb.y1 + 0.3], true);
      }
      if (!ePts.length) warnings.push('Couldn\'t find the tube end view edges for W, H and wall.');
    }
  } else if (plan.type === 'hex') {
    hexAnnotations({ plan, views, geometry, mainPts, mb, dim, layout, out, warnings, leaderNote });
  } else if (plan.type === 'round') {
    overall(mainPts, main.viewId, { height: false });
    const end = views.end;
    if (end) {
      const circles = circlesOf(geometry.end, end.matrix).sort((a, b) => b.dIn - a.dIn);
      circles.slice(0, 2).forEach((c, i) => leaderNote('end', [c], i === 0 ? `Ø${fmt(c.dIn)}` : holeLabel(c.dIn, 1)));
      if (!circles.length) warnings.push('Couldn\'t find the round edges in the end view for the OD and bore.');
    }
  } else {
    overall(mainPts, main.viewId);
    const right = views.right;
    if (right) overall(snapPoints(geometry.right, right.matrix), right.viewId, { height: false });
  }

  // Final check over everything: dimension text on the part or on other text.
  for (let i = 0; i < layout.boxes.length; i += 1) {
    const b = layout.boxes[i];
    if (layout.edges.some((s) => segHitsBox(s.a, s.b, b, 0.02))) layout.issues.push('some text sits on the part');
    for (let j = i + 1; j < layout.boxes.length; j += 1) if (boxesHit(b, layout.boxes[j], 0.02)) layout.issues.push('two pieces of text touch');
  }
  const issues = [...new Set(layout.issues)];
  if (issues.length) {
    out.push(note(keepWhole('AUTO-DRAWING NEEDS A CHECK'), [4.2, 7.85], 0.14));
    warnings.push(`Needs a check: ${issues.join('; ')}.`);
  }
  return { annotations: out, warnings, issues };
}

// Hex shaft, like the TSHAFT01 drawing: side view with the overall length
// below, the effective length (between the snap rings) above with a "View
// Snap Ring Standard" note, the size across the flats on the right, and the
// end view with the tapped or drilled hole.
function hexAnnotations({ plan, views, geometry, mainPts, mb, dim, layout, out, warnings, leaderNote }) {
  const info = plan.info;
  const main = views.main;
  if (!mb) { warnings.push('Couldn\'t find the shaft\'s edges in the side view.'); return; }
  const s = plan.s;
  const ex = extremes(mainPts);
  // Overall length, below. Measured end to end, never to a snap ring.
  dim(ex.left, ex.right, main.viewId, [(mb.x0 + mb.x1) / 2, mb.y0 - 0.45], true);

  // Across the flats: the top-most and bottom-most long straight edges
  // (a snap ring's outline is short, so it can't be picked).
  if (info.flatsSquare) {
    const longLines = (geometry.main || []).filter((e) => e && e.visible !== false && e.data && !e.isCenterline
      && String(e.type || '').toLowerCase() === 'line').map((e) => {
      const a = toPaper(main.matrix, e.data.start); const b = toPaper(main.matrix, e.data.end);
      return { e, a, b };
    }).filter((l) => Math.abs(l.a[1] - l.b[1]) < 1e-3 && Math.abs(l.a[0] - l.b[0]) > 0.4 * (mb.x1 - mb.x0));
    if (longLines.length >= 2) {
      longLines.sort((p, q) => p.a[1] - q.a[1]);
      const bottom = longLines[0]; const top = longLines[longLines.length - 1];
      const endPt = (l) => {
        const right = l.a[0] >= l.b[0];
        return { v: right ? l.e.data.start : l.e.data.end, id: l.e.uniqueId, did: l.e.deterministicId, snap: right ? 'ModeStart' : 'ModeEnd', p: right ? l.a : l.b };
      };
      const across = (top.a[1] - bottom.a[1]) / s;
      if (Math.abs(across - info.across) < 0.01) {
        dim(endPt(bottom), endPt(top), main.viewId, [mb.x1 + 0.5, (mb.y0 + mb.y1) / 2], false);
      } else {
        warnings.push(`Couldn't find the hex flats in the side view (found ${fmt(across)}", expected ${fmt(info.across)}").`);
      }
    } else {
      warnings.push('Couldn\'t find the hex flats in the side view for the across-flats size.');
    }
  }

  // Effective length: the inner-most edge within the groove zone at each end.
  if (info.effective) {
    // The groove walls sit where the shape check found them (ringOffsets
    // from each end), so look for edge points right there in the view.
    const inner = mainPts.filter((p) => p.p[0] > mb.x0 + 0.003 && p.p[0] < mb.x1 - 0.003);
    const tol = Math.max(0.02, 0.01 * s);
    const pick = (target) => {
      const near = inner.filter((p) => Math.abs(p.p[0] - target) < tol);
      if (!near.length) return null;
      const x = near.reduce((b, p) => (Math.abs(p.p[0] - target) < Math.abs(b - target) ? p.p[0] : b), near[0].p[0]);
      // Of the points on that edge, the top one (the snap ring note points there).
      return near.filter((p) => Math.abs(p.p[0] - x) < 1e-3).sort((p, q) => q.p[1] - p.p[1])[0];
    };
    // The view may show the shaft either way round, so try both.
    const [offA, offB] = info.ringOffsets || [0, 0];
    let lo = pick(mb.x0 + offA * s); let hi = pick(mb.x1 - offB * s);
    let measured = lo && hi ? (hi.p[0] - lo.p[0]) / s : null;
    if ((measured === null || Math.abs(measured - info.effective) >= 0.01) && Math.abs(offA - offB) > 0.002) {
      const lo2 = pick(mb.x0 + offB * s); const hi2 = pick(mb.x1 - offA * s);
      const m2 = lo2 && hi2 ? (hi2.p[0] - lo2.p[0]) / s : null;
      if (m2 !== null && Math.abs(m2 - info.effective) < 0.01) { lo = lo2; hi = hi2; measured = m2; }
    }
    if (measured !== null && Math.abs(measured - info.effective) < 0.01) {
      const mid = (lo.p[0] + hi.p[0]) / 2;
      const y = mb.y1 + 0.35;
      dim(lo, hi, main.viewId, [mid, y], true);
      const label = keepWhole('EFFECTIVE LENGTH');
      const w = CHAR_W * label.length;
      const lb = { x0: mid - w / 2, y0: y + 0.2, x1: mid + w / 2, y1: y + 0.4 };
      if (layout.fits(lb) >= 0) {
        layout.addLabel(lb);
        out.push(note(label, [lb.x0, y + 0.3], TEXT_H));
      } else layout.issues.push('no clean spot for the "EFFECTIVE LENGTH" label');
      // "View Snap Ring Standard", pointing at the snap ring near the left end.
      const text = keepWhole('View Snap Ring Standard');
      const tw = CHAR_W * text.length + 0.12;
      let placed = null;
      for (const ty of [y + 0.8, y + 1.05, y + 1.3]) {
        for (const tx of [mb.x0 - 0.3, mb.x0, mb.x0 + 0.4, mb.x0 - 0.7]) {
          const b = { x0: tx, y0: ty - 0.1, x1: tx + tw, y1: ty + 0.1 };
          const tail = [tx, ty - 0.1];
          if (layout.fits(b, tail, lo.p, lo.id) >= 0 && layout.fits(b, tail, lo.p, lo.id) <= 2) { placed = { b, tail, tx, ty }; break; }
        }
        if (placed) break;
      }
      if (placed) {
        layout.addLabel(placed.b, placed.tail, lo.p);
        out.push(note(text, [placed.tx, placed.ty], TEXT_H, ref(lo, main.viewId)));
      } else layout.issues.push('no clean spot for the "View Snap Ring Standard" note');
    } else {
      warnings.push('Couldn\'t find the snap ring grooves in the side view, so the effective length wasn\'t added.');
    }
  }

  // End view: the hole in the end (usually tapped).
  const end = views.end;
  if (end && info.bore) {
    const circles = circlesOf(geometry.end, end.matrix).filter((c) => Math.abs(c.dIn - info.bore) < 0.002);
    if (circles.length) leaderNote('end', circles, holeLabel(info.bore, 1));
    else warnings.push('Couldn\'t find the hole in the shaft\'s end view.');
  }
}

// How far a sheet point is from the nearest side of a box.
function edgeGap(p, b) {
  if (!b) return 0;
  return Math.min(p[0] - b.x0, b.x1 - p[0], p[1] - b.y0, b.y1 - p[1]);
}

// ---- Onshape calls -------------------------------------------------------
// api(path, options) is the server's onshapeFetch bound to the request.
async function waitForModify(api, id, what, first = { requestState: 'ACTIVE' }, waitSec = 90) {
  // Onshape API calls are capped per year, so check rarely: most edits are
  // done within a few seconds, so the first look waits 2.5 s. If Onshape
  // already says it's finished when the edit starts, no checks at all.
  const deadline = Date.now() + waitSec * 1000;
  let st = first && first.requestState ? first : { requestState: 'ACTIVE' };
  let delay = 2500;
  while (st.requestState === 'ACTIVE') {
    if (Date.now() > deadline) {
      const err = new Error(`Onshape took too long to ${what}.`);
      err.timedOut = true;
      throw err;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.6, 8000);
    st = await api(`/drawings/modify/status/${id}`);
  }
  if (st.requestState !== 'DONE') throw new Error(`Onshape couldn't ${what}${st.failureReason ? `: ${st.failureReason}` : '.'}`);
  let output = {};
  try { output = typeof st.output === 'string' ? JSON.parse(st.output) : (st.output || {}); } catch (err) { /* keep {} */ }
  return output;
}

async function modify(api, ctx, eid, description, jsonRequest, what, waitSec) {
  const started = await api(`/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${eid}/modify`, {
    method: 'POST',
    body: JSON.stringify({ description: description.slice(0, 32), jsonRequests: [{ formatVersion: '2021-01-01', ...jsonRequest }] }),
  });
  return waitForModify(api, started.id, what, started, waitSec);
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
// Which Onshape routes work is remembered (until the server restarts), so a
// route that fails isn't tried again, and paid for again, on every drawing.
const routes = { views: 'unknown', geometry: 'drawings' };

async function readViews(api, ctx, eid, exportJson) {
  let list = [];
  if (routes.views !== 'no') {
    try {
      const r = await api(`/drawings/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${eid}/views`);
      list = Array.isArray(r) ? r : (r.items || r.views || []);
    } catch (err) { /* fall back below */ }
    const usable = list.length && list.some((v) => v.viewToPaperMatrix);
    // Only give up on /views for good once it has answered without matrices.
    if (usable) routes.views = 'yes';
    else if (list.length) routes.views = 'no';
  }
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
  const order = routes.geometry === 'drawings' ? ['drawings', 'appelements'] : ['appelements', 'drawings'];
  let lastErr;
  for (const route of order) {
    try {
      const r = await api(`/${route}/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${eid}/views/${viewId}/jsongeometry`);
      routes.geometry = route;
      return r.bodyData || [];
    } catch (err) {
      lastErr = err;
      if (err.status === 401 || err.status === 402) throw err;
    }
  }
  throw lastErr;
}

// The whole job. Returns { drawingId, name, plan, warnings }.
// The views sit at fixed spots for a scale; this moves and rescales them for
// a new plan (used when the first layout doesn't pass the overlap check).
function editViewRequests(plan, logicalIds) {
  const out = [];
  plan.views.forEach((v, i) => {
    const id = logicalIds[i];
    if (!id) return;
    const edit = { logicalId: id, position: { x: round4(v.x), y: round4(v.y) } };
    if (v.key === 'main') edit.scale = { scaleSource: 'Custom', numerator: plan.scale[0], denumerator: plan.scale[1] };
    else if (v.scale) edit.scale = v.scale;
    out.push(edit);
  });
  return out;
}

async function readLayout(api, ctx, eid, plan, createdIds, exportJson) {
  const list = await readViews(api, ctx, eid, () => exportJson(eid));
  const views = matchViews(plan, list, createdIds);
  const geometry = {};
  for (const [key, v] of Object.entries(views)) {
    try { geometry[key] = await viewGeometry(api, ctx, eid, v.viewId); } catch (err) { geometry[key] = []; }
  }
  return { views, geometry, viewCount: list.length };
}

// Removes a drawing tab this request just made, when it ended up with no
// views, so it isn't left in the document looking like the part's drawing
// (the next try would otherwise find it and reuse the empty one).
async function deleteDrawingTab(api, ctx, eid) {
  try {
    await api(`/elements/d/${ctx.documentId}/w/${ctx.workspaceId}/e/${eid}`, { method: 'DELETE' });
    return true;
  } catch (err) {
    // Some deletes answer with an empty body, which isn't JSON; that's fine.
    return !err.status;
  }
}

function noViewsError(reason, deleted, name) {
  const why = String(reason || '').slice(0, 160);
  const err = new Error(`Onshape made the drawing tab but no views went into it${why ? ` (${why})` : ''}. `
    + (deleted ? 'The empty tab was removed, so press RETRY to try again.' : `Delete the empty "${name}" tab in Onshape, then press RETRY.`));
  return err;
}

// The whole job. Returns { drawingId, name, plan, warnings }.
// Each rescale costs about 10 Onshape calls (edit, status checks, reading the
// views back), and calls are capped per year, so don't retry smaller scales;
// a crowded drawing gets the "needs a check" note instead.
const MAX_LAYOUT_TRIES = 1;

async function makeDrawing({ api: rawApi, ctx, reference, body, box, name, partNumber, partName = '', qty, material, exportJson, helperName = null, existingHelper = null }) {
  let calls = 0;
  const api = (...args) => { calls += 1; return rawApi(...args); };
  const warnings = [];
  // A part modelled at an angle is drawn from a turned copy in a helper
  // assembly tab, since drawing views can only look along X, Y or Z.
  let helperId = null;
  const squared = helperName ? squareUp(body) : null;
  if (squared) {
    const deg = Math.round(tiltDegrees(squared.rotation));
    try {
      reference = await squaredCopy(api, ctx, { reference, rotation: squared.rotation, name: helperName, existing: existingHelper });
      helperId = reference.elementId;
      body = squared.body;
      box = require('./detect').bodyBox(body) || box;
      warnings.push(`This part sits at an angle (${deg}°) in its Part Studio, so it's drawn from a turned copy in the "${helperName}" tab. Keep that tab: the drawing reads from it.`);
    } catch (err) {
      if (err.status === 401 || err.status === 402) throw err;
      warnings.push(`This part sits at an angle (${deg}°) in its Part Studio and the app couldn't make a turned copy to draw from (${String(err.message).slice(0, 120)}), so the views are slanted.`);
    }
  }
  const info = analyzePart(body, box);
  let plan = planDrawing(info, { qty, material, partNumber, partName });
  warnings.push(...info.warnings);

  const created = await createDrawingElement(api, ctx, name);
  const eid = created.id || created.elementId || (created.element && created.element.id);
  if (!eid) throw new Error('Onshape made the drawing but didn\'t say which tab it is.');

  const requests = viewRequests(plan, reference);
  let viewOut;
  try {
    // Parts with hundreds of faces (a Tube Converter tube has a face for
    // every hole) can take Onshape a while to draw, so views get 3 minutes.
    viewOut = await modify(api, ctx, eid, 'Add views', { messageName: 'onshapeCreateViews', views: requests }, 'add the views', 180);
  } catch (err) {
    if (err.status === 401 || err.status === 402) throw err;
    // Still going: Onshape may finish the views after we stop waiting, so
    // the tab is kept rather than deleted half-way through.
    if (err.timedOut) {
      throw new Error(`Onshape took more than 3 minutes to draw the views for "${name}", so the app stopped before adding dimensions and notes. Open that tab: if the part is there, add the dimensions by hand; if it's empty, delete the tab and press RETRY.`);
    }
    throw noViewsError(err.message.replace(/^Onshape /, '').replace(/\.$/, ''), await deleteDrawingTab(api, ctx, eid), name);
  }
  const viewFails = failures(viewOut);
  const results = viewOut.results || [];
  if (results.length && viewFails.length === results.length) {
    throw noViewsError(viewFails[0], await deleteDrawingTab(api, ctx, eid), name);
  }
  if (viewFails.length) warnings.push(`Some views weren't added: ${viewFails.join('; ')}`);
  const createdIds = results.map((r) => ({ logicalId: r.logicalId }));

  // Lay out the dimensions and callouts; if something still collides, try
  // up to two smaller scales before settling for "needs a check".
  let result = null;
  let best = null; // { plan, result } with the fewest problems so far
  let emptyRead = false;
  for (let attempt = 0; attempt < MAX_LAYOUT_TRIES; attempt += 1) {
    let layout;
    try {
      layout = await readLayout(api, ctx, eid, plan, createdIds, exportJson);
    } catch (err) {
      warnings.push('Couldn\'t read the views back, so only the notes were added.');
      layout = { views: {}, geometry: {} };
    }
    // Onshape didn't say the views failed, but none could be read back.
    // That may only mean the read missed them, so keep the drawing but flag
    // it red on the Check drawings screen instead of calling it done.
    if (layout.viewCount === 0) {
      emptyRead = true;
      warnings.push('No views could be found on this drawing. Open it and check that the part is shown; if the sheet is empty, delete the tab and press RETRY.');
    }
    result = annotationsFor(plan, layout.views, layout.geometry);
    const count = (result.issues || []).length;
    if (!best || count < best.result.issues.length) best = { plan, result };
    if (!count || attempt === MAX_LAYOUT_TRIES - 1) break;
    const smaller = planDrawing(info, { qty, material, partNumber, partName, smallerThan: plan.scale });
    if (smaller.s >= plan.s) break;
    try {
      await modify(api, ctx, eid, 'Rescale views', { messageName: 'onshapeEditViews', views: editViewRequests(smaller, createdIds.map((c) => c.logicalId)) }, 'rescale the views');
      plan = smaller;
    } catch (err) {
      break;
    }
  }
  // Smaller wasn't better: put the views back where the best layout had them.
  if (best && best.plan !== plan) {
    try {
      await modify(api, ctx, eid, 'Rescale views', { messageName: 'onshapeEditViews', views: editViewRequests(best.plan, createdIds.map((c) => c.logicalId)) }, 'rescale the views');
      plan = best.plan;
      result = best.result;
    } catch (err) { /* keep the current layout and its own annotations */ }
  }
  const { annotations, warnings: annWarnings } = result;
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
  return { drawingId: eid, name, ...(helperId ? { helperId } : {}), plan: { type: plan.type, scale: plan.scale, orientation: plan.orientation }, needsCheck: emptyRead || Boolean(result.issues && result.issues.length), viewsMissing: emptyRead, warnings, calls };
}

// Whether a drawing tab has any views on it (1 call, or the drawing data
// export when Onshape's /views route doesn't give them). Used only when a
// drawing is asked for again after a reload or a RETRY.
async function hasViews(api, ctx, eid, exportJson) {
  return (await readViews(api, ctx, eid, () => exportJson(eid))).length > 0;
}

module.exports = {
  analyzePart, planDrawing, viewRequests, annotationsFor, makeDrawing, hasViews, deleteDrawingTab,
  sawNote, holeLabel, fmt, frac, matchViews,
};
