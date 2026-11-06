// npm test: starts the server with Onshape and LUNA Parts replaced by fakes
// (test/fake-apis.js), sends it a fixed set of requests (test/requests.js),
// and compares every answer and every outgoing call with the saved ones in
// test/expected/. Nothing real is called.
//
//   npm test             check nothing changed
//   npm test -- --update save the current behaviour as the new expected one
//                        (only after checking the differences are intended)

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const expectedDir = path.join(__dirname, 'expected');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-bridge-test-'));
const callLog = path.join(work, 'calls.log');
const PORT = '3999';

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch (err) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('The server did not start.');
}

(async () => {
  const server = spawn(process.execPath, ['-r', path.join(__dirname, 'fake-apis.js'), 'server.js'], {
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
      REDIS_URL: '',
    },
    // The server's own log is noisy here (the bad-input requests log errors on purpose).
    stdio: 'ignore',
  });
  let responses;
  try {
    await waitForServer();
    responses = execFileSync(process.execPath, [path.join(__dirname, 'requests.js')], {
      env: { ...process.env, BASE: `http://127.0.0.1:${PORT}` },
      encoding: 'utf8',
    });
  } finally {
    server.kill();
  }
  const got = { 'responses.jsonl': responses, 'calls.log': fs.readFileSync(callLog, 'utf8') };

  if (process.argv.includes('--update')) {
    fs.mkdirSync(expectedDir, { recursive: true });
    for (const [name, text] of Object.entries(got)) fs.writeFileSync(path.join(expectedDir, name), text);
    console.log('Saved the current behaviour to test/expected/.');
    return;
  }

  let failed = false;
  for (const [name, text] of Object.entries(got)) {
    const want = fs.readFileSync(path.join(expectedDir, name), 'utf8').split('\n');
    const have = text.split('\n');
    const n = Math.max(want.length, have.length);
    for (let i = 0; i < n; i += 1) {
      if (want[i] !== have[i]) {
        failed = true;
        console.error(`${name} line ${i + 1} changed:\n  expected: ${String(want[i]).slice(0, 300)}\n  got:      ${String(have[i]).slice(0, 300)}`);
        break;
      }
    }
  }
  if (failed) {
    console.error('\nSomething behaves differently. If that was on purpose, run: npm test -- --update');
    process.exit(1);
  }
  console.log(`All ${got['responses.jsonl'].trim().split('\n').length} responses and ${got['calls.log'].trim().split('\n').length} outgoing calls match.`);
})().catch((err) => { console.error(err); process.exit(1); });
