// Calling the Onshape REST API: one place that adds the login token, counts
// every call (Onshape caps how many the app gets a year) and pauses after the
// yearly limit is hit.

// ---- Onshape REST API ---------------------------------------------------
const ONSHAPE_API_BASE = process.env.ONSHAPE_API_BASE || 'https://cad.onshape.com/api';

const ONSHAPE_ID = /^[0-9a-f]{24}$/;

// ---- Counting Onshape calls ----------------------------------------------
// Onshape caps how many API calls the app gets a year, so every call is
// counted: per panel action (sent back in the X-Onshape-Calls header, which
// the panel adds up in its Sync log), and in total since the server started
// (the Render log prints a line for every action that used any).
const usage = { since: new Date().toISOString(), total: 0, byAction: {} };
function actionName(req) {
  return `${req.method} ${req.route ? req.route.path : req.path}`;
}

// Express middleware for /api: counts the Onshape calls each panel action
// makes and reports them in the X-Onshape-Calls headers and the Render log.
function countOnshapeCalls(req, res, next) {
  req.onshapeCalls = 0;
  const send = res.send.bind(res);
  res.send = (body) => {
    if (!res.headersSent) {
      res.set('X-Onshape-Calls', String(req.onshapeCalls));
      res.set('X-Onshape-Calls-Total', String(usage.total));
    }
    return send(body);
  };
  res.on('finish', () => {
    if (req.onshapeCalls) console.log(`[onshape calls] ${actionName(req)}: ${req.onshapeCalls} (${usage.total} since the server started)`);
  });
  next();
}

// After a 402 (yearly limit used up) the server stops calling Onshape for a
// while, so a panel left open can't keep hammering it.
const LIMIT_PAUSE_MS = 10 * 60 * 1000;
let limitHitAt = 0;

// { raw: true } returns the file bytes (a Buffer) instead of parsed JSON.
async function onshapeFetch(req, path, { raw = false, ...options } = {}) {
  if (Date.now() - limitHitAt < LIMIT_PAUSE_MS) {
    const err = new Error(`Onshape ${path} skipped: the yearly API limit was hit recently.`);
    err.status = 402;
    throw err;
  }
  req.onshapeCalls = (req.onshapeCalls || 0) + 1;
  usage.total += 1;
  const action = actionName(req);
  usage.byAction[action] = (usage.byAction[action] || 0) + 1;
  const res = await fetch(`${ONSHAPE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${req.session.onshapeTokens.accessToken}`,
      Accept: raw ? 'application/octet-stream' : 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    if (res.status === 402) limitHitAt = Date.now();
    const err = new Error(`Onshape ${path} returned ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  if (raw) return Buffer.from(await res.arrayBuffer());
  // Some edits (moving a part in an assembly, deleting a tab) answer with an
  // empty body. That's a success, not broken JSON.
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : {};
}

// 402 is Onshape's yearly API call limit: apps that aren't in the Onshape
// App Store get a fixed number of calls a year, and after that every call
// is refused until Onshape adds more.
const API_LIMIT_MESSAGE = 'Onshape has refused the request (402): the yearly limit on API calls for this app has been used up. '
  + 'Ask Onshape for more at api-support@onshape.com.';
function onshapeErrorMessage(err) {
  if (err.status === 402) return API_LIMIT_MESSAGE;
  return err.status === 401
    ? 'Your Onshape login expired. Close and reopen the panel.'
    : `Could not read parts from Onshape (${err.status || 'network error'}).`;
}

module.exports = {
  ONSHAPE_API_BASE,
  ONSHAPE_ID,
  usage,
  countOnshapeCalls,
  onshapeFetch,
  API_LIMIT_MESSAGE,
  onshapeErrorMessage,
};
