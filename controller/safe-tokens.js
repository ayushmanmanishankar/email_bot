const fs = require('fs');
const path = require('path');
const TOKEN_PATH = path.join(__dirname, '..', 'tokens.json');
const TMP_TOKEN_PATH = path.join(__dirname, '..', 'tokens.tmp.json');

function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8') || '';
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error('loadTokens failed (returning null):', e && e.message ? e.message : e);
    return null;
  }
}

function saveTokens(raw) {
  try {
    if (!raw || typeof raw !== 'object') {
      console.warn('saveTokens: nothing to save, raw invalid');
      return;
    }

    // Extract canonical fields safely from possible shapes
    const canonical = {
      access_token:
        raw.access_token ||
        (raw.tokens && raw.tokens.access_token) ||
        (raw.credentials && raw.credentials.access_token) ||
        null,
      refresh_token:
        raw.refresh_token ||
        (raw.tokens && raw.tokens.refresh_token) ||
        (raw.credentials && raw.credentials.refresh_token) ||
        null,
      scope:
        raw.scope || (raw.tokens && raw.tokens.scope) || (raw.credentials && raw.credentials.scope) || null,
      token_type:
        raw.token_type || (raw.tokens && raw.tokens.token_type) || (raw.credentials && raw.credentials.token_type) || null,
      expiry_date:
        raw.expiry_date ||
        (raw.tokens && raw.tokens.expiry_date) ||
        (raw.credentials && raw.credentials.expiry_date) ||
        null
    };

    // Merge with existing file, but do not overwrite an existing refresh_token with null
    const existing = loadTokens() || {};
    const merged = {
      access_token: canonical.access_token || existing.access_token || null,
      refresh_token: canonical.refresh_token || existing.refresh_token || null,
      scope: canonical.scope || existing.scope || null,
      token_type: canonical.token_type || existing.token_type || null,
      expiry_date: canonical.expiry_date || existing.expiry_date || null
    };

    // atomic write: write tmp then rename
    fs.writeFileSync(TMP_TOKEN_PATH, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(TMP_TOKEN_PATH, TOKEN_PATH);
    console.log('Tokens saved (canonical).');
  } catch (err) {
    console.error('saveTokens failed:', err && err.message ? err.message : err);
  }
}

module.exports = { loadTokens, saveTokens, TOKEN_PATH };
