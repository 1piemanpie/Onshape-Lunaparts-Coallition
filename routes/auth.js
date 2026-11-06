// Logging in with Onshape (OAuth 2), and the panel's "am I logged in?" check.

const crypto = require('crypto');
const express = require('express');
const { ONSHAPE_ID } = require('../lib/onshape/api');

const router = express.Router();

const ONSHAPE_AUTHORIZE_URL = 'https://oauth.onshape.com/oauth/authorize';
const ONSHAPE_TOKEN_URL = 'https://oauth.onshape.com/oauth/token';

function callbackUrl(req) {
  return `${req.protocol}://${req.get('host')}/oauth/callback`;
}

// Step 1: this is the "OAuth URL" registered with Onshape. Onshape fetches
// it to start login — we send the browser on to Onshape's own authorize
// screen, with a random `state` value we can verify on the way back.
//
// The Onshape extension's Action URL points here too, with the open
// document's IDs filled in by Onshape. We keep those in the session so the
// panel knows which Part Studio it's sitting in once login finishes.

router.get('/oauth/login', (req, res) => {
  const { documentId, workspaceId, elementId } = req.query;
  if ([documentId, workspaceId, elementId].every((id) => ONSHAPE_ID.test(id || ''))) {
    req.session.onshapeContext = { documentId, workspaceId, elementId };
  }

  // Already logged in with a token that hasn't expired: skip straight to the panel.
  // ?force=1 logs in again, e.g. after the app was given edit permission.
  const tokens = req.session.onshapeTokens;
  if (tokens && tokens.expiresAt > Date.now() && req.query.force !== '1') {
    return res.redirect('/');
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: process.env.ONSHAPE_CLIENT_ID,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    state,
  });

  res.redirect(`${ONSHAPE_AUTHORIZE_URL}?${params.toString()}`);
});

// Step 2: Onshape redirects back here (the registered "Redirect URL") with
// a one-time code. We exchange it, server-side, for an access token —
// this is the one request that needs the client secret, which is why it
// can't happen in the browser.
router.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('OAuth state mismatch — please try connecting again.');
  }
  delete req.session.oauthState;

  if (!code) {
    return res.status(400).send('Onshape did not return an authorization code.');
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.ONSHAPE_CLIENT_ID,
      client_secret: process.env.ONSHAPE_CLIENT_SECRET,
      redirect_uri: callbackUrl(req),
    });

    const tokenRes = await fetch(ONSHAPE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      console.error('Onshape token exchange failed:', tokenRes.status, await tokenRes.text());
      return res.status(502).send('Could not complete Onshape login. Please try again.');
    }

    const tokens = await tokenRes.json();
    req.session.onshapeTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };

    res.redirect('/');
  } catch (err) {
    console.error('Onshape token exchange error:', err);
    res.status(502).send('Could not complete Onshape login. Please try again.');
  }
});

// Lets the panel's front-end check whether this session is logged in yet.
router.get('/api/session', (req, res) => {
  res.json({
    connected: Boolean(req.session.onshapeTokens),
    context: req.session.onshapeContext || null,
  });
});

module.exports = router;
