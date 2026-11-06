// Luna Parts Bridge: the server behind the Onshape side panel.
//
// This file only wires things together. The work lives in:
//   routes/auth.js     logging in with Onshape
//   routes/onshape.js  the panel's Onshape routes (parts, shapes, names, drawings)
//   routes/luna.js     the panel's LUNA Parts routes (lists, create, files)
//   lib/onshape/       calling Onshape, caching, parts, title blocks, exports
//   lib/luna.js        calling LUNA Parts
//   lib/middleware.js  checks shared by the routes (logged in? inside Onshape?)
//   lib/schemas.js     what each route accepts (zod)
//   lib/session-store.js  where logins are kept (Render Key Value or memory)
//   lib/*.js           geometry: DXFs, drawings, part detection, twins

const express = require('express');
const session = require('express-session');
const path = require('path');
const { countOnshapeCalls } = require('./lib/onshape/api');
const { sessionStore } = require('./lib/session-store');

const app = express();
const PORT = process.env.PORT || 3000;

// Render sits behind a proxy that terminates HTTPS, so Express needs this
// to know the original request was secure (required for secure cookies
// and for req.protocol to correctly report "https" below).
app.set('trust proxy', 1);

app.use(session({
  // Render Key Value when REDIS_URL is set, otherwise memory.
  store: sessionStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // The panel loads inside an iframe on Onshape's domain, which makes
    // this a third-party cookie from the browser's point of view —
    // SameSite=None + Secure is required or browsers will silently drop it.
    sameSite: 'none',
    secure: true,
  },
}));

// Serves everything in /public — right now that's just the panel UI
// (public/index.html). Onshape will point at this server's URL and load
// that page inside an iframe in the sidebar.
app.use(express.static(path.join(__dirname, 'public')));

// Render (and Onshape, when checking your app is alive) can hit this to
// confirm the server is up.
app.get('/health', (req, res) => res.send('ok'));

app.use(require('./routes/auth'));

// Every other /api response says how many Onshape calls it used, and JSON
// bodies are read for all of them.
app.use('/api', countOnshapeCalls);
app.use('/api', express.json());

app.use(require('./routes/onshape'));
app.use(require('./routes/luna'));

app.listen(PORT, () => {
  console.log(`Luna Parts Bridge listening on port ${PORT}`);
});
