// Checks shared by the API routes. Each one answers the request itself (with
// the same message the routes always sent) when the check fails.

const { currentDwe } = require('./onshape/cache');

// The browser has logged in with Onshape (it holds a token in its session).
function requireLogin(req, res, next) {
  if (!req.session.onshapeTokens) return res.status(401).json({ error: 'Log in with Onshape first.' });
  next();
}

// The panel was opened from inside an Onshape document, so the session knows
// which Part Studio or assembly it's in. Sets req.dwe ("d/<doc>/w/<ws>/e/<tab>").
function requirePanel(req, res, next) {
  const dwe = currentDwe(req);
  if (!dwe) return res.status(401).json({ error: 'Open the panel from inside Onshape first.' });
  req.dwe = dwe;
  next();
}

// The LUNA Parts API key is set in Render.
function requireLunaKey(req, res, next) {
  if (!process.env.LUNA_PARTS_API_KEY) {
    return res.status(500).json({ error: 'LUNA_PARTS_API_KEY is not set on the server.' });
  }
  next();
}

module.exports = { requireLogin, requirePanel, requireLunaKey };
