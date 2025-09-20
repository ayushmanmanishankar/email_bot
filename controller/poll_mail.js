// controller/poll_mail.js
const cron = require('node-cron');
const { google } = require('googleapis');
const localDB = require('./db');
const { postEmailFetch } = require('./process_mail');

const MY_EMAIL = (process.env.MY_EMAIL || 'test.demo@reverieinc.com').toLowerCase();

// How many user/assistant messages to include in the compact LLM context
const CONTEXT_USER = Number(process.env.CONTEXT_USER) || 1;
const CONTEXT_ASSISTANT = Number(process.env.CONTEXT_ASSISTANT) || 1;

// Short-lived dedupe set for recently-sent message IDs to avoid race windows
const recentlySent = new Set();
const RECENTLY_SENT_TTL_MS = 60 * 1000; // 60 seconds

function addRecentlySent(id) {
  if (!id) return;
  recentlySent.add(String(id));
  setTimeout(() => recentlySent.delete(String(id)), RECENTLY_SENT_TTL_MS);
}

function buildContextForLLM(threadMsgs, nUser = CONTEXT_USER, mAssistant = CONTEXT_ASSISTANT) {
  // threadMsgs assumed oldest->newest
  const users = threadMsgs.filter(m => !m.sentByUs);
  const assists = threadMsgs.filter(m => !!m.sentByUs);

  const lastUsers = users.slice(-nUser);
  const lastAssists = assists.slice(-mAssistant);

  // keep chronological order
  const idsToInclude = new Set([...lastAssists, ...lastUsers].map(m => m.id));
  return threadMsgs.filter(m => idsToInclude.has(m.id));
}

/**
 * Start Gmail poller
 * @param {OAuth2Client} oauth2Client
 * @param {Function} ensureAuth - async fn ensuring oauth2Client has valid credentials
 */
async function startGmailPoller(oauth2Client, ensureAuth) {
  try {
    console.log('Starting Gmail poller...');

    cron.schedule('*/5 * * * * *', async () => {
      try {
        await ensureAuth();

        const db = await localDB.loadDB();
        db.messages = db.messages || {};
        db.threads = db.threads || {};

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: 10, includeSpam: true });
        const messages = listRes.data.messages || [];
        if (!messages.length) return;

        console.log('Cron: fetched', messages.length, 'messages at', new Date().toISOString());

        // Only fetch details for messages we haven't seen AND not in recentlySent
        const unseen = messages.filter(m => !db.messages[m.id] && !recentlySent.has(String(m.id)));
        if (!unseen.length) return;

        const fetched = await Promise.all(
          unseen.map(msg => {
            if (!msg.id) return Promise.resolve({ ok: false, id: null, err: 'Missing message ID' });
            return gmail.users.messages
              .get({ userId: 'me', id: msg.id, format: 'full' })
              .then(res => ({ ok: true, id: msg.id, res }))
              .catch(err => ({ ok: false, id: msg.id, err }));
          })
        );

        const msgMetas = [];

        for (const item of fetched) {
          if (!item.ok) {
            console.error('Failed to fetch message:', item.id, item.err?.message || item.err);
            continue;
          }

          const full = item.res.data;
          const headers = full.payload?.headers || [];

          const findHeader = name => {
            const h = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
            return h ? h.value : null;
          };

          const from = findHeader('from') || '';
          const subject = findHeader('subject') || '';
          const messageIdHeader = findHeader('message-id') || findHeader('message-id') || null;
          const replyToHeader = findHeader('reply-to') || null;

          const sentByUs = (from || '').toLowerCase().includes(MY_EMAIL);

          msgMetas.push({
            id: item.id,
            threadId: full.threadId,
            snippet: full.snippet || '',
            from,
            subject,
            date: full.internalDate ? new Date(Number(full.internalDate)).toISOString() : new Date().toISOString(),
            messageIdHeader,
            replyToHeader,
            sentByUs
          });
        }

        if (!msgMetas.length) return;

        // Upsert into DB, preserving existing status where present
        const dbAfterUpsert = await localDB.loadDB(); // reload to avoid races
        dbAfterUpsert.messages = dbAfterUpsert.messages || {};
        dbAfterUpsert.threads = dbAfterUpsert.threads || {};

        for (const mm of msgMetas) {
          const existing = dbAfterUpsert.messages[mm.id] || {};
          const status = existing.status ? existing.status : (mm.sentByUs ? 'sent' : 'new');

          dbAfterUpsert.messages[mm.id] = {
            ...existing,
            id: mm.id,
            threadId: mm.threadId,
            snippet: mm.snippet,
            from: mm.from,
            subject: mm.subject,
            date: mm.date,
            messageIdHeader: mm.messageIdHeader || existing.messageIdHeader || null,
            replyToHeader: mm.replyToHeader || existing.replyToHeader || null,
            sentByUs: !!mm.sentByUs,
            status
          };

          dbAfterUpsert.threads[mm.threadId] = dbAfterUpsert.threads[mm.threadId] || [];
          if (!dbAfterUpsert.threads[mm.threadId].includes(mm.id)) {
            dbAfterUpsert.threads[mm.threadId].push(mm.id);
          }
        }

        await localDB.saveDB(dbAfterUpsert);

        // Build thread list to process
        const threadsToProcess = [...new Set(msgMetas.map(m => m.threadId))];

        for (const tid of threadsToProcess) {
          const fullDb = await localDB.loadDB();
          const threadIds = fullDb.threads[tid] || [];
          const threadMsgs = threadIds
            .map(id => fullDb.messages[id])
            .filter(Boolean)
            .sort((a, b) => new Date(a.date) - new Date(b.date));

          const newMsgs = threadMsgs.filter(m => m.status === 'new' && !m.sentByUs);
          if (!newMsgs.length) continue;

          // Build compact context (latest user message + last assistant reply)
          const contextForLLM = buildContextForLLM(threadMsgs);

          try {
            // pass both full thread (for DB) and compact context to process
            await postEmailFetch({ threadId: tid, threadMessages: threadMsgs, contextForLLM }, null, { oauth2Client, addRecentlySent });
          } catch (err) {
            console.error('postEmailFetch error for thread', tid, err && err.message ? err.message : err);
          }
        }

      } catch (err) {
        console.error('Cron error', err && err.message ? err.message : err);
      }
    });

    console.log('Gmail poller started (cron every 5 sec).');
  } catch (err) {
    console.error('Failed to start cron:', err && err.message ? err.message : err);
  }
}

module.exports = { startGmailPoller, addRecentlySent };
