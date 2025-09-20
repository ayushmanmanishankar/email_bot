// controllers/db.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '..', 'email_db.json');
const DB_TMP = path.resolve(__dirname, '..', 'email_db.tmp.json');
const DB_CORRUPT_BACKUP_DIR = path.resolve(__dirname, '..', 'db_corrupt_backups');

async function ensureBackupDir() {
  try {
    await fs.mkdir(DB_CORRUPT_BACKUP_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
}

/**
 * Safe JSON parse: returns null on parse error.
 */
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * If DB file is corrupt, move to a timestamped backup for forensics.
 */
async function backupCorruptFile(raw) {
  try {
    await ensureBackupDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(DB_CORRUPT_BACKUP_DIR, `email_db_corrupt_${ts}.json`);
    // write the raw contents for inspection
    await fs.writeFile(backupPath, raw, 'utf8');
    console.warn('Backed up corrupt DB to', backupPath);
  } catch (err) {
    console.error('Failed to backup corrupt DB file', err);
  }
}

/**
 * Load DB from file. If missing/empty => returns initial shape.
 * If parse error: backup corrupt file and return initial shape.
 */
async function loadDB() {
  try {
    if (!fsSync.existsSync(DB_PATH)) {
      return { messages: {}, threads: {} };
    }
    const raw = String(await fs.readFile(DB_PATH, 'utf8') || '').trim();
    if (!raw) {
      return { messages: {}, threads: {} };
    }
    const parsed = safeParse(raw);
    if (parsed) return parsed;

    // Attempt to salvage by finding first {...} JSON object in file
    const braceMatch = raw.match(/\{[\s\S]*\}$/);
    if (braceMatch) {
      const candidate = braceMatch[0];
      const p2 = safeParse(candidate);
      if (p2) {
        console.warn('Recovered DB from trailing-garbage file by extracting last JSON object');
        return p2;
      }
    }

    // Unknown corruption: back up raw and return empty DB
    await backupCorruptFile(raw);
    return { messages: {}, threads: {} };
  } catch (err) {
    // If reading fails for some other reason, log and return initial shape
    console.error('loadDB failed, returning initial shape:', err && err.message ? err.message : err);
    return { messages: {}, threads: {} };
  }
}

/**
 * Atomic save: write to temp file then rename to main DB file (POSIX atomic rename).
 */
async function saveDB(obj) {
  try {
    const raw = JSON.stringify(obj, null, 2);
    await fs.writeFile(DB_TMP, raw, 'utf8');
    // fs.rename is atomic on most platforms
    await fs.rename(DB_TMP, DB_PATH);
    return true;
  } catch (err) {
    console.error('saveDB failed:', err);
    // attempt direct write as fallback
    try {
      await fs.writeFile(DB_PATH, JSON.stringify(obj, null, 2), 'utf8');
      return true;
    } catch (err2) {
      console.error('saveDB fallback write failed:', err2);
      throw err2;
    }
  }
}

module.exports = { loadDB, saveDB, DB_PATH, DB_TMP };
