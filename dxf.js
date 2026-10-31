// Turns one flat face of an Onshape part into a 2D DXF, the kind a laser
// cutter or router takes. Everything comes from Onshape's bodydetails data
// (face loops, edge curves, points in meters): lines and circles/arcs are
// written exactly, and any other curve (spline, ellipse) as a polyline
// through Onshape's tessellated points for that edge.
//
// Output is DXF R12 in inches: the oldest, most widely readable flavour.

const METERS_TO_INCHES = 1 / 0.0254;

function vec(p) {
  if (!p) return null;
  return Array.isArray(p) ? p.slice(0, 3) : [p.x, p.y, p.z];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => scale(a, 1 / Math.hypot(...a));

function isPlanar(face) {
  return Boolean(face && face.surface && face.surface.type === 'PLANE');
}

// The face the user clicked if it's flat; otherwise the part's biggest flat
// face (for a plate, the top or bottom, which cut the same).
function pickFace(body, faceId) {
  const faces = body.faces || [];
  const clicked = faces.find((f) => f.id === faceId);
  if (isPlanar(clicked)) return { face: clicked, usedClicked: true };
  const largest = faces.filter(isPlanar).sort((a, b) => (b.area || 0) - (a.area || 0))[0];
  return { face: largest || null, usedClicked: false };
}

function faceEdges(body, face) {
  const edgesById = new Map((body.edges || []).map((e) => [e.id, e]));
  const ids = new Set();
  for (const loop of face.loops || []) {
    for (const coedge of loop.coedges || []) ids.add(coedge.edgeId);
  }
  return [...ids].map((id) => edgesById.get(id)).filter(Boolean);
}

// Edges other than lines and circles need extra points; returns their IDs.
function edgesNeedingPoints(body, face) {
  return faceEdges(body, face)
    .filter((e) => !['LINE', 'CIRCLE'].includes(e.curve && e.curve.type))
    .map((e) => e.id);
}

// A 2D coordinate system lying in the face, looking at it from outside, with
// X along the longest straight edge so plates come out square to the sheet.
function faceFrame(face, edges) {
  const surface = face.surface;
  let normal = norm(vec(surface.normal));
  if (surface.isOrientedWithFace === false) normal = scale(normal, -1);

  let xAxis = null;
  let longest = 0;
  for (const edge of edges) {
    if (!edge.curve || edge.curve.type !== 'LINE' || !edge.geometry) continue;
    const d = sub(vec(edge.geometry.endPoint), vec(edge.geometry.startPoint));
    const inPlane = sub(d, scale(normal, dot(d, normal)));
    const length = Math.hypot(...inPlane);
    if (length > longest) { longest = length; xAxis = norm(inPlane); }
  }
  if (!xAxis) {
    const helper = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    xAxis = norm(cross(helper, normal));
  }
  const yAxis = cross(normal, xAxis);
  const origin = vec(surface.origin);

  return (p) => {
    const d = sub(vec(p), origin);
    return [dot(d, xAxis) * METERS_TO_INCHES, dot(d, yAxis) * METERS_TO_INCHES];
  };
}

const TWO_PI = 2 * Math.PI;
const angleOf = (p, c) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const ccwSweep = (from, to) => ((to - from) % TWO_PI + TWO_PI) % TWO_PI;
const degrees = (a) => ((a * 180) / Math.PI + 360) % 360;

// Returns { entities, usedClicked } or throws with a user-facing message.
// edgePoints: Map of edgeId -> [points] for edges that aren't lines/circles.
function faceToDxf(body, faceId, edgePoints = new Map()) {
  const { face, usedClicked } = pickFace(body, faceId);
  if (!face) throw new Error('This part has no flat face to make a DXF from.');

  const edges = faceEdges(body, face);
  const to2d = faceFrame(face, edges);
  const entities = [];

  for (const edge of edges) {
    const type = edge.curve && edge.curve.type;
    const g = edge.geometry || {};
    if (type === 'LINE') {
      entities.push({ kind: 'LINE', a: to2d(g.startPoint), b: to2d(g.endPoint) });
    } else if (type === 'CIRCLE') {
      const center = to2d(edge.curve.origin);
      const radius = edge.curve.radius * METERS_TO_INCHES;
      const start = to2d(g.startPoint);
      const end = to2d(g.endPoint);
      if (Math.hypot(start[0] - end[0], start[1] - end[1]) < 1e-6) {
        entities.push({ kind: 'CIRCLE', center, radius });
      } else {
        // DXF arcs always run counter-clockwise, so check which way round
        // the edge goes by where its midpoint falls.
        const a0 = angleOf(start, center);
        const a1 = angleOf(end, center);
        const am = angleOf(to2d(g.midPoint), center);
        const ccw = ccwSweep(a0, am) < ccwSweep(a0, a1);
        entities.push({
          kind: 'ARC', center, radius,
          start: degrees(ccw ? a0 : a1), end: degrees(ccw ? a1 : a0),
        });
      }
    } else {
      const points = edgePoints.get(edge.id)
        || [g.startPoint, g.quarterPoint, g.midPoint, g.endPoint].filter(Boolean);
      entities.push({ kind: 'POLYLINE', points: points.map(to2d) });
    }
  }

  // Put the part's corner at 0,0.
  const all = entities.flatMap((e) => {
    if (e.kind === 'LINE') return [e.a, e.b];
    if (e.kind === 'POLYLINE') return e.points;
    return [[e.center[0] - e.radius, e.center[1] - e.radius]];
  });
  const minX = Math.min(...all.map((p) => p[0]));
  const minY = Math.min(...all.map((p) => p[1]));
  const shift = (p) => [p[0] - minX, p[1] - minY];

  return { dxf: writeDxf(entities, shift), usedClicked, entityCount: entities.length };
}

function writeDxf(entities, shift) {
  const out = [];
  const pair = (code, value) => out.push(String(code), typeof value === 'number' ? value.toFixed(6) : String(value));
  const point = (p, base = 10) => { const [x, y] = shift(p); pair(base, x); pair(base + 10, y); pair(base + 20, 0); };

  pair(0, 'SECTION'); pair(2, 'HEADER');
  pair(9, '$ACADVER'); pair(1, 'AC1009');
  pair(9, '$INSUNITS'); pair(70, '1');
  pair(0, 'ENDSEC');
  pair(0, 'SECTION'); pair(2, 'ENTITIES');

  for (const e of entities) {
    if (e.kind === 'LINE') {
      pair(0, 'LINE'); pair(8, '0'); point(e.a, 10); point(e.b, 11);
    } else if (e.kind === 'CIRCLE') {
      pair(0, 'CIRCLE'); pair(8, '0'); point(e.center); pair(40, e.radius);
    } else if (e.kind === 'ARC') {
      pair(0, 'ARC'); pair(8, '0'); point(e.center); pair(40, e.radius); pair(50, e.start); pair(51, e.end);
    } else {
      pair(0, 'POLYLINE'); pair(8, '0'); pair(66, '1');
      pair(10, 0); pair(20, 0); pair(30, 0); pair(70, '0');
      for (const p of e.points) { pair(0, 'VERTEX'); pair(8, '0'); point(p); }
      pair(0, 'SEQEND'); pair(8, '0');
    }
  }

  pair(0, 'ENDSEC'); pair(0, 'EOF');
  return `${out.join('\n')}\n`;
}

module.exports = { faceToDxf, edgesNeedingPoints, pickFace, isPlanar };
