const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { startGmailPoller } = require('../controller/poll_mail');
const { _internal } = require('../controller/process_mail');
const { loadTokens, saveTokens } = require('../controller/safe-tokens');

const credentials = require('../credentials.json');
const { client_id, client_secret } = credentials.installed || credentials.web;

const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
const TOKEN_PATH = path.join(__dirname, '..', 'tokens.json');

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  REDIRECT_URI
);

// Register the tokens listener exactly once (move this out of ensureAuth)
if (!oauth2Client.__tokensListenerAdded) {
  oauth2Client.on('tokens', (newTokens) => {
    try {
      const existing = loadTokens() || {};
      const merged = {
        access_token: newTokens.access_token || existing.access_token || null,
        // preserve existing refresh_token if newTokens doesn't include it
        refresh_token: newTokens.refresh_token || existing.refresh_token || null,
        scope: newTokens.scope || existing.scope || null,
        token_type: newTokens.token_type || existing.token_type || null,
        expiry_date: newTokens.expiry_date || existing.expiry_date || null
      };
      saveTokens(merged);
      // update client credentials too
      oauth2Client.setCredentials(merged);
      console.log('Tokens refreshed (tokens event) and saved.');
    } catch (e) {
      console.error('Failed saving refreshed tokens from tokens event:', e && e.message ? e.message : e);
    }
  });
  oauth2Client.__tokensListenerAdded = true;
  console.log('tokens listener added; current listeners:', oauth2Client.listenerCount('tokens'));
}

// Gmail scopes
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
];


// ----------------------------------------
// Ensure OAuth2 client has valid tokens
// ----------------------------------------
async function ensureAuth() {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error('No stored tokens. Visit /auth to authorize the app.');
  }

  // set credentials into client
  oauth2Client.setCredentials(tokens);

  // ensure we have or can get a refresh token
  const refreshToken = (oauth2Client.credentials && oauth2Client.credentials.refresh_token) || tokens.refresh_token;
  if (!refreshToken) {
    throw new Error('No refresh_token available. Re-authorize the app by visiting /auth.');
  }

  // check expiry
  const expiry = oauth2Client.credentials && oauth2Client.credentials.expiry_date;
  const needsRefresh = !oauth2Client.credentials || !oauth2Client.credentials.access_token ||
    (typeof expiry === 'number' && Date.now() > (expiry - TOKEN_EXPIRY_BUFFER_MS));

  if (!needsRefresh) return; // credentials ok

  // explicit refresh
  try {
    const resp = await oauth2Client.refreshToken(refreshToken);
    const newCreds = (resp && resp.credentials) ? resp.credentials : resp;

    const merged = {
      ...tokens,
      ...newCreds,
      // prefer refresh token from newCreds if present, otherwise preserve existing
      refresh_token: newCreds.refresh_token || tokens.refresh_token || refreshToken
    };

    // persist canonical merged tokens
    saveTokens(merged);
    oauth2Client.setCredentials(merged);
    console.log('Access token refreshed and saved (explicit).');
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes('invalid_grant')) {
      // fatal - token revoked/expired
      throw new Error('invalid_grant: refresh token invalid or revoked — re-authorize the app at /auth.');
    }
    throw err;
  }
}

// ----------------------------------------
// Routes
// ----------------------------------------

// Home
router.get('/', (req, res) => {
  res.render('index', { title: 'Express' });
});

// Start OAuth flow
router.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // ensures refresh_token is returned
    scope: SCOPES,
    prompt: 'consent'       // always return refresh_token for first-time auth
  });
  res.redirect(url);
});

// OAuth2 callback
router.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code in query');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);

    // Start Gmail poller now that we have tokens
    await startGmailPoller(oauth2Client, ensureAuth);

    res.send('Authorization successful — tokens saved and Gmail poller started. You can close this window.');
  } catch (err) {
    console.error('Error exchanging code for token', err);
    res.status(500).send('Error while trying to exchange code for token');
  }
});

// Example: list messages from local DB
router.get('/messages', async (req, res) => {
  try {
    const db = await _internal.loadDB();
    db.messages = db.messages || {};

    const results = Object.values(db.messages).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(results);
  } catch (err) {
    console.error('Error in /messages:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------
// Start Gmail poller
// ----------------------------------------
(async () => {
  try {
    await ensureAuth();
    await startGmailPoller(oauth2Client, ensureAuth);
  } catch (err) {
    console.log('Cron not started. Visit /auth to authorize.', err.message);
  }
})();

module.exports = { router, ensureAuth, oauth2Client };
