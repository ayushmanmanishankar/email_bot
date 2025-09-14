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

async function postEmailFetch(meta, full) {
  try {
    // Example: log and demonstrate access to body/header
    // You can replace this with DB persistence, webhook, NLP processing, etc.
    console.log('postEmailFetch called for message id:', meta.id);

    // Example: extract a plain text payload if present (best-effort)
    let bodyText = '';
    const payload = full?.data?.payload;
    if (payload) {
      // If 'parts' exist, try to find text/plain part; otherwise look at body.data
      if (payload.parts && Array.isArray(payload.parts)) {
        // naive traversal -- you might want a robust recursive extractor
        const part = payload.parts.find(p => p.mimeType === 'text/plain') || payload.parts[0];
        if (part && part.body && part.body.data) {
          bodyText = Buffer.from(part.body.data, 'base64').toString('utf8');
        }
      } else if (payload.body && payload.body.data) {
        bodyText = Buffer.from(payload.body.data, 'base64').toString('utf8');
      }
    }

    // Do something with meta and bodyText:
    // e.g. persist to DB, call an external service, trigger a background job, etc.
    // For now we'll just log snippet + body length to keep it safe and generic.
    console.log(`meta.subject="${meta.subject}" from="${meta.from}" snippetLen=${(meta.snippet||'').length} bodyLen=${bodyText.length}`);

    // If you want to return something, return it. Otherwise return undefined.
    return { handled: true };
  } catch (err) {
    // Do NOT throw here unless you want upstream callers to fail.
    console.error('postEmailFetch error:', err);
    return { handled: false, error: err.message };
  }
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
      const msgMeta = {
        id: m.id,
        threadId: full.data.threadId,
        snippet: full.data.snippet,
        from,
        subject
      };

      // call the post-fetch hook (await so caller sees errors if you want)
      try {
        await postEmailFetch(msgMeta, full);
      } catch (hookErr) {
        // we already catch inside postEmailFetch, but keep this defensive
        console.error('Error in postEmailFetch (messages endpoint):', hookErr);
      }

      results.push(msgMeta);
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

    // Optionally call postEmailFetch here too (we pass a minimal meta and full)
    const meta = { id: req.params.id, threadId: full.data.threadId, snippet: full.data.snippet || '' };
    try {
      await postEmailFetch(meta, full);
    } catch (hookErr) {
      console.error('Error in postEmailFetch (raw endpoint):', hookErr);
    }

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

          // fetch and handle each message (call postEmailFetch for processing)
          for (const m of messages) {
            try {
              const full = await gmail.users.messages.get({
                userId: 'me',
                id: m.id,
                format: 'full'
              });

              const headers = full.data.payload?.headers || [];
              const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
              const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
              const msgMeta = {
                id: m.id,
                threadId: full.data.threadId,
                snippet: full.data.snippet,
                from,
                subject
              };

              // call the same hook used in endpoints
              await postEmailFetch(msgMeta, full);
            } catch (innerErr) {
              console.error('Error fetching or processing message in cron:', innerErr);
            }
          }
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
