// Where logins (express-session sessions) are kept.
//
// With REDIS_URL set (Render Key Value, see docs/render-setup.md), sessions
// live in Key Value, so a deploy or restart no longer logs everyone out of
// the panel. Without it they stay in the server's memory, as before.

const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');

// A session lasts a day after the panel was last used. (Onshape's own login
// token inside it runs out sooner; reopening the panel gets a new one.)
const SESSION_TTL_SECONDS = 24 * 60 * 60;

function sessionStore() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('REDIS_URL is not set, so logins are kept in memory and a restart logs everyone out.');
    return undefined; // express-session's built-in memory store
  }

  const client = createClient({
    url,
    // If Key Value goes away for a moment, keep trying to reconnect (every
    // 0.5 s at first, then every 5 s). Requests wait for it meanwhile.
    socket: { reconnectStrategy: (retries) => Math.min((retries + 1) * 500, 5000) },
  });
  // Without an error listener a lost connection would crash the server.
  client.on('error', (err) => console.error('Key Value (session store) error:', err.message));
  client.on('ready', () => console.log('Connected to Key Value: logins now survive restarts.'));
  client.connect().catch((err) => console.error('Could not connect to Key Value:', err.message));

  return new RedisStore({ client, prefix: 'luna-bridge:sess:', ttl: SESSION_TTL_SECONDS });
}

module.exports = { sessionStore };
