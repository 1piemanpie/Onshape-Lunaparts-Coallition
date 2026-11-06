// npm test (Node's built-in test runner, node:test).
//
// Starts the server with Onshape and LUNA Parts replaced by fakes
// (test/fake-apis.js), sends it a fixed set of requests (test/requests.js),
// and checks every answer and every outgoing call against the saved ones in
// test/expected/. Nothing real is called and no keys are needed.
//
//   npm test                 check nothing changed
//   npm run test:update      save the current behaviour as the new expected
//                            one (only after checking the differences are meant)
//   TEST_REDIS_URL=redis://... npm test   the same, with logins in a real Redis

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const expectedDir = path.join(__dirname, 'expected');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-bridge-test-'));
const callLog = path.join(work, 'calls.log');
const PORT = '3999';
// npm sets npm_lifecycle_event to the script's name, which works the same on Windows.
const UPDATE = process.env.npm_lifecycle_event === 'test:update';

let server;
let responses = [];
let calls = '';

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch (err) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('The server did not start.');
}

before(async () => {
  server = spawn(process.execPath, ['-r', path.join(__dirname, 'fake-apis.js'), 'server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT,
      MOCK_LOG: callLog,
      SESSION_SECRET: 'test-secret',
      ONSHAPE_CLIENT_ID: 'test-client',
      ONSHAPE_CLIENT_SECRET: 'test-secret',
      LUNA_PARTS_API_KEY: 'test-key',
      LUNA_PARTS_API_BASE: '',
      ONSHAPE_API_BASE: '',
      REDIS_URL: process.env.TEST_REDIS_URL || '',
    },
    // The server's own log is noisy here (the bad-input requests log errors on purpose).
    stdio: 'ignore',
  });
  await waitForServer();
  const out = execFileSync(process.execPath, [path.join(__dirname, 'requests.js')], {
    env: { ...process.env, BASE: `http://127.0.0.1:${PORT}` },
    encoding: 'utf8',
  });
  responses = out.trim().split('\n');
  calls = fs.readFileSync(callLog, 'utf8');
  if (UPDATE) {
    fs.mkdirSync(expectedDir, { recursive: true });
    fs.writeFileSync(path.join(expectedDir, 'responses.jsonl'), out);
    fs.writeFileSync(path.join(expectedDir, 'calls.log'), calls);
  }
});

after(() => {
  if (server) server.kill();
});

test('every response matches the saved one', async (t) => {
  const expected = fs.readFileSync(path.join(expectedDir, 'responses.jsonl'), 'utf8').trim().split('\n');
  assert.equal(responses.length, expected.length, 'number of responses');
  for (let i = 0; i < expected.length; i += 1) {
    const want = JSON.parse(expected[i]);
    await t.test(want.name || `response ${i + 1}`, () => {
      assert.deepEqual(JSON.parse(responses[i]), want);
    });
  }
});

test('every call to Onshape and LUNA Parts matches the saved ones', () => {
  const expected = fs.readFileSync(path.join(expectedDir, 'calls.log'), 'utf8').split('\n');
  assert.deepEqual(calls.split('\n'), expected);
});
