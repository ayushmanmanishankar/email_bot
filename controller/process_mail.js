// controller/process_mail.js
const localDB = require('./db');
const { respond_mail } = require('./respond_mail');

const MY_EMAIL = (process.env.MY_EMAIL || 'test.demo@reverieinc.com').toLowerCase();

/**
 * Get messages for a thread ordered oldest->newest
 */
function getThreadMessages(db, threadId) {
  return (db.threads[threadId] || [])
    .map(id => db.messages[id])
    .filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

/**
 * postEmailFetch(meta, full, options)
 *
 * meta:
 *  - { threadId, threadMessages, contextForLLM }  (from poller)
 *  - OR single-message form (legacy) - not used primarily here
 *
 * options:
 *  - oauth2Client (required for sending)
 *  - addRecentlySent (optional fn from poller to mark dedupe)
 */
async function postEmailFetch(meta, full, options = {}) {
  try {
    const db = await localDB.loadDB();
    db.messages = db.messages || {};
    db.threads = db.threads || {};

    // If caller provided threadMessages (poller), upsert them (preserve existing status)
    if (meta && Array.isArray(meta.threadMessages)) {
      for (const m of meta.threadMessages) {
        const existing = db.messages[m.id] || {};
        const sentByUs = !!m.sentByUs || ((m.from || '').toLowerCase().includes(MY_EMAIL));
        const status = existing.status || (sentByUs ? 'sent' : 'new');

        db.messages[m.id] = {
          ...existing,
          id: m.id,
          threadId: m.threadId,
          snippet: m.snippet,
          from: m.from,
          subject: m.subject,
          date: m.date || new Date().toISOString(),
          messageIdHeader: m.messageIdHeader || existing.messageIdHeader || null,
          replyToHeader: m.replyToHeader || existing.replyToHeader || null,
          sentByUs,
          status
        };

        db.threads[m.threadId] = db.threads[m.threadId] || [];
        if (!db.threads[m.threadId].includes(m.id)) db.threads[m.threadId].push(m.id);
      }
      await localDB.saveDB(db);
    }

    // Decide which new messages to process: those still marked 'new' and not sentByUs
    // Use the threadMessages in DB authoritative ordering
    const threadId = meta.threadId;
    if (!threadId) return { handled: true, reason: 'no_thread_id' };

    const currentDb = await localDB.loadDB();
    const threadMessages = getThreadMessages(currentDb, threadId);
    const newMessages = threadMessages.filter(m => m.status === 'new' && !m.sentByUs);
    if (!newMessages.length) return { handled: true, reason: 'no_new_user_messages' };

    const results = [];

    // Build LLM context: prefer meta.contextForLLM if present, else build minimal context
    // meta.contextForLLM is already the compact context built by poller (oldest->newest)
    const metaContext = Array.isArray(meta.contextForLLM) ? meta.contextForLLM.slice() : [];

    // Ensure latest user message is included (safety)
    const latestFull = threadMessages[threadMessages.length - 1];
    if (!metaContext.length || metaContext[metaContext.length - 1].id !== latestFull.id) {
      // If metaContext lacks latest, append it
      // But first ensure we include it as the newest item in the context
      metaContext.push(latestFull);
    }

    for (const nm of newMessages) {
      // reload DB authoritative
      const dbNow = await localDB.loadDB();
      // skip if status changed in the meantime
      if (dbNow.messages[nm.id] && dbNow.messages[nm.id].status !== 'new') {
        results.push({ id: nm.id, ok: false, reason: 'status_changed' });
        continue;
      }

      try {
        // Call respond_mail with compact context only
        const resp = await respond_mail(metaContext, null, null, options);

        if (resp && resp.ok) {
          // mark the triggering user message as responded
          const db2 = await localDB.loadDB();
          if (db2.messages && db2.messages[nm.id]) {
            db2.messages[nm.id].status = 'responded';
            db2.messages[nm.id].respondedAt = new Date().toISOString();
          }

          // Insert sent message record to DB so poller won't treat it as new (and optionally inform in-memory dedupe)
          if (resp.sentMessageId) {
            const sentId = String(resp.sentMessageId);
            const db3 = await localDB.loadDB();
            if (!db3.messages[sentId]) {
              db3.messages[sentId] = {
                id: sentId,
                threadId: resp.sentThreadId || nm.threadId,
                snippet: (resp.sentBody || '').slice(0, 300),
                from: resp.fromHeader || process.env.MY_EMAIL || 'me',
                subject: resp.sentSubject || (`Re: ${nm.subject || ''}`),
                date: new Date().toISOString(),
                messageIdHeader: resp.sentMessageHeader || null,
                sentByUs: true,
                status: 'sent'
              };
              db3.threads[db3.messages[sentId].threadId] = db3.threads[db3.messages[sentId].threadId] || [];
              if (!db3.threads[db3.messages[sentId].threadId].includes(sentId)) {
                db3.threads[db3.messages[sentId].threadId].push(sentId);
              }
            } else {
              db3.messages[sentId].sentByUs = true;
              db3.messages[sentId].status = db3.messages[sentId].status || 'sent';
              db3.messages[sentId].messageIdHeader = db3.messages[sentId].messageIdHeader || resp.sentMessageHeader || null;
            }
            // save and also add to poller's recentlySent if provided
            await localDB.saveDB(db3);
            if (typeof options.addRecentlySent === 'function') {
              try {
                options.addRecentlySent(sentId);
              } catch (e) { /* ignore */ }
            }
          } else {
            await localDB.saveDB(db2);
          }

          results.push({ id: nm.id, ok: true, resp });
        } else {
          // mark user message for human review as appropriate
          if (resp && resp.human_review) {
            const db4 = await localDB.loadDB();
            if (db4.messages && db4.messages[nm.id]) {
              db4.messages[nm.id].status = 'human_review';
              db4.messages[nm.id].humanReviewReason = resp.reason || 'LLM requested review';
              db4.messages[nm.id].llm_raw = resp.raw || resp.llmRaw || null;
              await localDB.saveDB(db4);
            }
          }
          results.push({ id: nm.id, ok: false, resp });
        }
      } catch (err) {
        console.error('Error processing new message', nm.id, err && err.message ? err.message : err);
        // mark for human review
        const dbErr = await localDB.loadDB();
        if (dbErr.messages && dbErr.messages[nm.id]) {
          dbErr.messages[nm.id].status = 'human_review';
          dbErr.messages[nm.id].humanReviewReason = err.message || String(err);
          await localDB.saveDB(dbErr);
        }
        results.push({ id: nm.id, ok: false, error: (err && err.message) || String(err) });
      }
    }

    return { handled: true, threadId, processed: results.length, results };
  } catch (err) {
    console.error('postEmailFetch error:', err && err.message ? err.message : err);
    return { handled: false, error: (err && err.message) || String(err) };
  }
}

module.exports = {
  postEmailFetch,
  _internal: { getThreadMessages }
};
