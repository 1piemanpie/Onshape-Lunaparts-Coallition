// Tells whether two same-size parts are copies, mirror images, or different.
//
// Mass properties (volume, area, inertia) can't see a hole moved a little or
// a part that's been mirrored, so this lines the two parts up by their key
// points (line ends and circle centres from Onshape's bodydetails) and checks
// that every point lands on a point of the other part.
//
// Each part's points get their own axes, centred on the points' average and
// fixed by how the points spread out. Those axes move with the part, so a
// copy lines up exactly. Axis directions can come out either way round, so
// all 8 sign choices are tried: a match with an even number of flips is a copy
// (the part just turned round); a match that needs an odd number is its
// mirror image. A mirror that also matches itself flipped is symmetric, so
// it's still the same physical part (a plate with only through holes).

const TOL = 5e-5; // metres (0.002 in)

function vec(p) {
  if (!p) return null;
  return Array.isArray(p) ? p.slice(0, 3).map(Number) : [Number(p.x), Number(p.y), Number(p.z)];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };

// Points that come out the same wherever a copy is placed and however it
// was modelled: line ends, other curves' ends, and circle and arc centres
// (tagged with the radius). Arc ends are left out because a hole can be one
// circle in one part and two half-circles in its copy, and a closed curve's
// start point is just where Onshape put the seam.
function keyPoints(body) {
  const pts = [];
  for (const edge of (body && body.edges) || []) {
    const g = edge.geometry || {};
    const type = String((edge.curve && edge.curve.type) || '').toLowerCase();
    const start = vec(g.startPoint);
    const end = vec(g.endPoint);
    if (type === 'circle' || type === 'arc') {
      const origin = vec(edge.curve.origin);
      const radius = Number(edge.curve.radius);
      if (origin && radius > 0) pts.push({ p: origin, tag: `r${Math.round(radius / TOL)}` });
    } else if (start && end && (type === 'line' || len(sub(start, end)) > TOL)) {
      pts.push({ p: start, tag: '' }, { p: end, tag: '' });
    }
  }
  // Shared corners appear once per edge: keep one.
  const grid = new Map();
  const out = [];
  for (const t of pts) {
    if (t.p.some((x) => !Number.isFinite(x)) || hasPoint(grid, t.p, t.tag)) continue;
    addPoint(grid, t.p, t.tag);
    out.push(t);
  }
  return out;
}

// Eigenvalues and vectors of a symmetric 3x3 matrix (Jacobi rotations).
function eigen(m) {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) for (let q = p + 1; q < 3; q += 1) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k += 1) {
          const akp = a[k][p]; const akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k += 1) {
          const apk = a[p][k]; const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k += 1) {
          const vkp = v[k][p]; const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return [0, 1, 2]
    .map((i) => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] }))
    .sort((x, y) => x.value - y.value);
}

function shapeInfo(tagged) {
  const points = tagged.map((t) => t.p);
  const n = points.length;
  const c = [0, 1, 2].map((i) => points.reduce((s, p) => s + p[i], 0) / n);
  const rel = points.map((p) => sub(p, c));
  const tags = tagged.map((t) => t.tag);
  const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rel.reduce((s, p) => s + p[i] * p[j], 0) / n));
  const eig = eigen(cov);
  return { rel, eig, tags };
}

// Frames that land on the same spot of a copy: one axis is the eigen axis
// whose spread differs most from the other two (that direction is fixed by
// the shape), and the first axis points from it to the point furthest out.
// For B every point the same distance out is tried, since a symmetric part
// has several such points.
function frames(info, ref) {
  const { eig, rel } = info;
  const scale = Math.max(eig[2].value, 1e-18);
  const gaps = [0, 1, 2].map((i) => Math.min(...[0, 1, 2].filter((j) => j !== i).map((j) => Math.abs(eig[i].value - eig[j].value))));
  const k = gaps.indexOf(Math.max(...gaps));
  if (gaps[k] <= 1e-3 * scale) return null; // equally spread every way: no telling which way round it is
  const axis = unit(eig[k].vector);
  const radial = (p) => sub(p, scaleVec(axis, dot(p, axis)));
  const describe = (p) => ({ r: len(radial(p)), h: Math.abs(dot(p, axis)) });
  const frameTo = (p) => {
    const e1 = unit(radial(p));
    return [e1, cross(axis, e1), axis];
  };
  if (!ref) {
    let best = null;
    for (const p of rel) {
      const d = describe(p);
      if (d.r > TOL && (!best || d.r > best.d.r + TOL || (Math.abs(d.r - best.d.r) <= TOL && d.h > best.d.h + TOL))) best = { p, d };
    }
    if (!best) return null;
    return { frames: [frameTo(best.p)], ref: best.d };
  }
  const out = [];
  for (const p of rel) {
    const d = describe(p);
    if (Math.abs(d.r - ref.r) <= TOL && Math.abs(d.h - ref.h) <= TOL) out.push(frameTo(p));
    if (out.length >= 64) break;
  }
  return { frames: out, ref };
}
function scaleVec(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

function project(rel, f) { return rel.map((p) => [dot(p, f[0]), dot(p, f[1]), dot(p, f[2])]); }

function addPoint(grid, p, tag) {
  const key = p.map((x) => Math.floor(x / TOL)).join(',') + tag;
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push(p);
}
function gridOf(points, tags) {
  const grid = new Map();
  points.forEach((p, n) => addPoint(grid, p, tags[n]));
  return grid;
}
function hasPoint(grid, p, tag) {
  const [i, j, k] = p.map((x) => Math.floor(x / TOL));
  for (let a = -1; a <= 1; a += 1) for (let b = -1; b <= 1; b += 1) for (let c = -1; c <= 1; c += 1) {
    for (const q of grid.get(`${i + a},${j + b},${k + c}${tag}`) || []) {
      if (Math.abs(q[0] - p[0]) <= TOL && Math.abs(q[1] - p[1]) <= TOL && Math.abs(q[2] - p[2]) <= TOL) return true;
    }
  }
  return false;
}

const SIGNS = [];
for (const x of [1, -1]) for (const y of [1, -1]) for (const z of [1, -1]) SIGNS.push([x, y, z]);

// Which sign flips put B's points onto A's: { proper, improper }.
function matches(a, b) {
  const fa = frames(a, null);
  if (!fa) return null;
  const fb = frames(b, fa.ref);
  if (!fb) return null;
  const pa = project(a.rel, fa.frames[0]);
  const grid = gridOf(pa, a.tags);
  const found = { proper: false, improper: false };
  for (const f of fb.frames) {
    const pb = project(b.rel, f);
    for (const s of SIGNS) {
      const kind = s[0] * s[1] * s[2] > 0 ? 'proper' : 'improper';
      if (found[kind]) continue;
      if (pb.every((p, n) => hasPoint(grid, [p[0] * s[0], p[1] * s[1], p[2] * s[2]], b.tags[n]))) found[kind] = true;
    }
    if (found.proper && found.improper) break;
  }
  return found;
}

// 'same' (a copy, or a mirror of a symmetric part), 'mirror' (a true
// left/right pair), 'different', or 'unknown' (too symmetric to line up).
function compareBodies(bodyA, bodyB) {
  const pa = keyPoints(bodyA);
  const pb = keyPoints(bodyB);
  if (pa.length < 3 || pb.length < 3) return 'unknown';
  if (pa.length !== pb.length) return 'different';
  const a = shapeInfo(pa);
  const b = shapeInfo(pb);
  if (a.eig.some((e, i) => Math.abs(e.value - b.eig[i].value) > 1e-3 * Math.max(a.eig[2].value, 1e-18))) return 'different';
  const m = matches(a, b);
  if (!m) return 'unknown';
  if (m.proper) return 'same';
  if (!m.improper) return 'different';
  // B is A's mirror image. If A matches its own mirror image, it's symmetric
  // and the mirror is the same part.
  const self = matches(a, a);
  return self && self.improper ? 'same' : 'mirror';
}

module.exports = { compareBodies, keyPoints };
