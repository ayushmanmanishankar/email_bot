// routes/index.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const cron = require('node-cron');

const credentials = require('../credentials.json');
// credentials may be in installed or web block depending on how you downloaded them:
const { client_id, client_secret } = credentials.installed || credentials.web;

// IMPORTANT: redirect URI must match what you set in Google Cloud Console
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  REDIRECT_URI
);

// Gmail scope (read-only). Change to other scopes if you need modify/send.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// Where we'll persist tokens in this example (replace with secure store in prod)
const TOKEN_PATH = path.join(__dirname, '..', 'tokens.json');

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
}

// Utility: decode base64url (Gmail returns base64url encoded raw parts)
function base64UrlDecode(str) {
  // replace URL-safe chars then decode
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  // pad with =
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Express' });
});

// Start OAuth flow: visit /auth to grant access
router.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // important to get refresh_token
    scope: SCOPES,
    prompt: 'consent'       // ensure refresh_token is returned on first consent
  });
  res.redirect(url);
});

// OAuth2 callback route configured in Google Cloud Console
router.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing code in query');
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // persist tokens
    saveTokens(tokens);
    res.send('Authorization successful — tokens saved. You can close this window.');
  } catch (err) {
    console.error('Error exchanging code for token', err);
    res.status(500).send('Error while trying to exchange code for token');
  }
});

// Helper: ensure oauth2Client has credentials (either from file or env)
async function ensureAuth() {
  const tokens = loadTokens();
  if (tokens) {
    oauth2Client.setCredentials(tokens);
  } else {
    throw new Error('No stored tokens. Visit /auth to authorize the app.');
  }
}

// Example API endpoint: list last N messages (ids and snippet)
router.get('/messages', async (req, res) => {
  try {
    await ensureAuth();
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 20
    });
    const messages = (listRes.data.messages || []);
    // fetch details for each message (you can limit fields)
    const results = [];
    for (const m of messages) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'full' // or 'minimal','metadata','raw'
      });
      // snippet + headers sample
      const headers = full.data.payload?.headers || [];
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
      results.push({
        id: m.id,
        threadId: full.data.threadId,
        snippet: full.data.snippet,
        from,
        subject
      });
    }
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Example endpoint: get raw body (for one message id)
router.get('/messages/:id/raw', async (req, res) => {
  try {
    await ensureAuth();
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: req.params.id,
      format: 'raw' // raw is base64url encoded full RFC822 message
    });
    const raw = full.data.raw;
    const decoded = base64UrlDecode(raw);
    res.type('text/plain').send(decoded);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/*
  Example cron job:
  - polls Gmail every minute for new messages (you can change schedule)
  - this demonstrates how to run periodic fetches server-side
  In production you might want push notifications (Pub/Sub) instead of polling.
*/
// Only start cron if tokens exist (avoid repeated auth errors)
try {
  const tokens = loadTokens();
  if (tokens) {
    oauth2Client.setCredentials(tokens);
    // run every minute: change cron schedule as needed
    cron.schedule('* * * * *', async () => {
      try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const r = await gmail.users.messages.list({ userId: 'me', maxResults: 5 });
        const messages = r.data.messages || [];
        if (messages.length) {
          console.log('Cron: fetched', messages.length, 'messages at', new Date().toISOString());
          // optionally fetch bodies or process them
          // e.g. fetch first message body:
          // const full = await gmail.users.messages.get({userId: 'me', id: messages[0].id, format:'full'});
          // console.log(full.data.snippet);
        }
      } catch (err) {
        console.error('Cron error', err.message || err);
      }
    });
    console.log('Gmail poller started (cron).');
  } else {
    console.log('No tokens.json found — cron not started. Visit /auth to authorize.');
  }
} catch (err) {
  console.error('Failed to start cron:', err);
}

module.exports = router;
