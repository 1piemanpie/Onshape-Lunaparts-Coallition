const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serves everything in /public — right now that's just the panel UI
// (public/index.html). Onshape will point at this server's URL and load
// that page inside an iframe in the sidebar.
app.use(express.static(path.join(__dirname, 'public')));

// Render (and Onshape, when checking your app is alive) can hit this to
// confirm the server is up.
app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`Parts Tracker Bridge listening on port ${PORT}`);
});
