// The synced parts list (lib/luna.js getParts): a full read first, then only
// what changed, with deleted parts dropped. Uses a stubbed fetch, no server.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.LUNA_PARTS_API_KEY = 'test-key';
const calls = [];
let answer;
global.fetch = async (url) => {
  const u = new URL(url);
  calls.push(`${u.pathname.replace('/api/v1/', '')}?${u.searchParams}`);
  const body = answer(u);
  return new Response(JSON.stringify(body), { status: 200, headers: { Date: 'Wed, 11 Nov 2026 02:00:00 GMT' } });
};
const { getParts } = require('../lib/luna');

const part = (id, extra = {}) => ({ id, project_id: 5, part_number: `26O-E${id}`, ...extra });

test('first read is the whole list, page by page', async () => {
  answer = (u) => {
    const pageNo = Number(u.searchParams.get('page'));
    return { data: pageNo === 1 ? [part(1), part(2)] : [part(3)], current_page: pageNo, last_page: 2, next_page_url: null };
  };
  const parts = await getParts();
  assert.deepEqual(parts.map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(calls.splice(0), ['parts?per_page=100&page=1', 'parts?per_page=100&page=2']);
});

test('later reads ask only for changes since LUNA\'s clock minus 2 minutes', async () => {
  answer = () => ({ data: [part(2, { name: 'renamed' }), part(4)], deleted_ids: [3], current_page: 1, last_page: 1 });
  const parts = await getParts();
  assert.deepEqual(parts.map((p) => p.id), [1, 2, 4]);
  assert.equal(parts.find((p) => p.id === 2).name, 'renamed');
  assert.deepEqual(calls.splice(0), ['parts?updated_since=2026-11-11T01%3A58%3A00Z&per_page=100&page=1']);
});

test('a part sent with deleted_at, or ids as a comma list, is dropped too', async () => {
  answer = () => ({ data: [part(4, { deleted_at: '2026-11-11T02:00:00Z' })], deleted_ids: '1', current_page: 1, last_page: 1 });
  assert.deepEqual((await getParts()).map((p) => p.id), [2]);
  calls.splice(0);
});

test('if LUNA ignores updated_since (no deleted_ids), the answer replaces the list', async () => {
  answer = () => ({ data: [part(7), part(8)], current_page: 1, last_page: 1 });
  assert.deepEqual((await getParts()).map((p) => p.id), [7, 8]);
  calls.splice(0);
});

test('reads at the same moment share one request', async () => {
  answer = () => ({ data: [], deleted_ids: [], current_page: 1, last_page: 1 });
  await Promise.all([getParts(), getParts(), getParts()]);
  assert.equal(calls.splice(0).length, 1);
});
