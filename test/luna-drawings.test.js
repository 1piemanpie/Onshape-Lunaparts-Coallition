// Which LUNA parts have a drawing (lib/luna.js drawingStatus): one attachments
// list per part, cached, bought parts and assemblies left out. Stubbed fetch.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.LUNA_PARTS_API_KEY = 'test-key';
const calls = [];
const files = {
  1: [{ original_filename: '26O-E001 Drawing 1.pdf', revision: 1 }],
  2: [{ original_filename: '26O-E002.dxf', extension: 'dxf' }],
  3: [{ original_filename: 'sheet.png', is_drawing: 1, revision: 2 }],
  4: [],
  6: [{ original_filename: 'old.pdf', deleted_at: '2026-11-01' }],
};
global.fetch = async (url) => {
  const u = new URL(url);
  const m = u.pathname.match(/parts\/(\d+)\/attachments$/);
  calls.push(m[1]);
  if (m[1] === '9') return new Response('{}', { status: 500 });
  return new Response(JSON.stringify({ data: files[m[1]] || [], current_page: 1, last_page: 1 }), { status: 200 });
};
const { drawingStatus, forgetDrawingInfo } = require('../lib/luna');

const part = (id, extra = {}) => ({ id, project_id: 5, part_number: `26O-E00${id}`, name: `P${id}`, type: 'part', updated_at: 't1', ...extra });

test('a PDF or an is_drawing file counts as a drawing; bought parts are skipped', async () => {
  const rows = await drawingStatus([part(2), part(1), part(3), part(4), part(5, { type: 'purchased' }), part(6), part(7, { type: 'assembly' })]);
  assert.deepEqual(rows.map((r) => [r.number, r.hasDrawing]), [
    ['26O-E001', true], ['26O-E002', false], ['26O-E003', true], ['26O-E004', false], ['26O-E006', false],
  ]);
  assert.equal(rows[0].drawingFile, '26O-E001 Drawing 1.pdf');
  assert.deepEqual(calls.splice(0).sort(), ['1', '2', '3', '4', '6']);
});

test('answers are reused until the part changes or the panel uploads to it', async () => {
  await drawingStatus([part(1), part(2), part(4, { updated_at: 't2' })]);
  assert.deepEqual(calls.splice(0), ['4']);
  forgetDrawingInfo(2);
  files[2].push({ original_filename: '26O-E002 Drawing 1.pdf', is_drawing: true });
  const rows = await drawingStatus([part(2)]);
  assert.equal(rows[0].hasDrawing, true);
  assert.deepEqual(calls.splice(0), ['2']);
});

test('a part whose files can\'t be read is kept, with the error', async () => {
  const rows = await drawingStatus([part(9)]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].error, /500/);
  assert.equal(rows[0].hasDrawing, undefined);
  calls.splice(0);
});
