// lib/key-lock.js: jobs on the same key run one at a time, in order;
// jobs on different keys don't wait for each other.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withKeys } = require('../lib/key-lock');

const tick = () => new Promise((r) => setTimeout(r, 5));

test('same key: the second job starts after the first one ends', async () => {
  const seen = [];
  const job = (name) => async () => { seen.push(`${name} start`); await tick(); seen.push(`${name} end`); return name; };
  const results = await Promise.all([withKeys(['num:5:26o-e060'], job('a')), withKeys(['num:5:26o-e060'], job('b'))]);
  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(seen, ['a start', 'a end', 'b start', 'b end']);
});

test('different keys run side by side', async () => {
  const seen = [];
  const job = (name) => async () => { seen.push(`${name} start`); await tick(); seen.push(`${name} end`); };
  await Promise.all([withKeys(['num:5:a'], job('a')), withKeys(['num:5:b'], job('b'))]);
  assert.deepEqual(seen, ['a start', 'b start', 'a end', 'b end']);
});

test('a job that shares any one key waits; a failed job still lets the next one run', async () => {
  const seen = [];
  const first = withKeys(['link:x', 'num:5:a'], async () => { await tick(); seen.push('first'); throw new Error('LUNA down'); });
  const second = withKeys(['num:5:a'], async () => { seen.push('second'); });
  await assert.rejects(first, /LUNA down/);
  await second;
  assert.deepEqual(seen, ['first', 'second']);
});
