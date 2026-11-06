// Drawing layout checks against saved part shapes (no Onshape calls).
const test = require('node:test');
const assert = require('node:assert');
const { analyzePart, planDrawing, annotationsFor } = require('../lib/drawings');
const { detectPart } = require('../lib/detect');
const shaft = require('./fixtures/hex-shaft-snap-rings.json');

const IN = 0.0254;
const near = (a, b, tol = 0.002) => Math.abs(a - b) <= tol;

test('hex shaft with fused snap rings is a hex shaft, not "other"', () => {
  const info = analyzePart(shaft.body, shaft.box);
  assert.strictEqual(info.type, 'hex');
  assert.ok(near(info.across, 0.5), `across flats ${info.across}`);
  assert.ok(near(info.length, 2.703), `length ${info.length}`);
  assert.ok(near(info.effective, 2.5), `effective ${info.effective}`);
  assert.ok(info.rounded);
  assert.ok(near(info.bore, 0.201), `bore ${info.bore}`);
  const d = detectPart(shaft.body, shaft.box);
  assert.strictEqual(d.machine, 'lathe');
  assert.strictEqual(d.needsDxf, false);
});

test('hex shaft drawing: overall + effective length, across flats, snap ring note', () => {
  const info = analyzePart(shaft.body, shaft.box);
  const plan = planDrawing(info, { qty: 2, material: 'Steel' });
  assert.ok(plan.notes.includes('Stock: 1/2" rounded hex'));
  const views = {};
  for (const v of plan.views) {
    if (shaft.geometry[v.key]) views[v.key] = { viewId: `V${v.key}`, matrix: [plan.s / IN, 0, 0, v.x, 0, plan.s / IN, 0, v.y, 0, 0, 1, 0] };
  }
  const r = annotationsFor(plan, views, shaft.geometry);
  assert.deepStrictEqual(r.issues, []);
  assert.deepStrictEqual(r.warnings, []);
  const dims = r.annotations.filter((a) => a.pointToPointDimension).map((a) => {
    const { point1, point2, rotation } = a.pointToPointDimension;
    const i = rotation ? 1 : 0;
    return Math.abs(point1.coordinate[i] - point2.coordinate[i]) / IN;
  });
  // Overall length, across flats (never the snap ring's OD), effective length.
  assert.ok(dims.some((x) => near(x, 2.703)), `dims ${dims}`);
  assert.ok(dims.some((x) => near(x, 0.5)), `dims ${dims}`);
  assert.ok(dims.some((x) => near(x, 2.5)), `dims ${dims}`);
  assert.ok(!dims.some((x) => near(x, 0.5645, 0.01) || near(x, 0.634, 0.01)), `snap ring measured: ${dims}`);
  const notes = r.annotations.filter((a) => a.note).map((a) => a.note.contents.replace(/ /g, ' '));
  assert.ok(notes.includes('EFFECTIVE LENGTH'));
  assert.ok(notes.includes('View Snap Ring Standard'));
  assert.ok(notes.includes('1/4-20 TAP'));
});
