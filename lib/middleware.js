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

// Checks req[source] ('query', 'body' or 'params') against one of the
// schemas in lib/schemas.js. On success the cleaned-up values are added to
// req.input; otherwise the panel gets a 400 with that field's message.
function validate(source, { schema, messages, all = false }) {
  return (req, res, next) => {
    const data = req[source];
    // A JSON body that isn't an object (e.g. a list) counts as empty.
    const input = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const result = schema.safeParse(input);
    if (!result.success) {
      const failed = new Set(result.error.issues.map((issue) => issue.path[0]));
      const problems = [...new Set(Object.keys(messages).filter((key) => failed.has(key)).map((key) => messages[key]))];
      return res.status(400).json({ error: all ? problems.join(' ') : problems[0] });
    }
    req.input = { ...req.input, ...result.data };
    next();
  };
}

module.exports = { requireLogin, requirePanel, requireLunaKey, validate };
