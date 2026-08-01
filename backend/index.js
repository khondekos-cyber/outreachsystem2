const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const decisionService = require('./services/decisionService');
const knowledgeService = require('./services/knowledgeService');
const pipelineService = require('./services/pipelineService');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const authPath = process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth';

// On a host like Render, a container getting killed/restarted often leaves
// Chromium's lock files behind on the persistent disk from the previous run.
// The next launch then refuses to start, thinking another process still owns
// the profile, even though nothing actually does. Clear those before launch.
function clearStaleChromeLocks(dir) {
    if (!fs.existsSync(dir)) return;
    const lockFileNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            clearStaleChromeLocks(full);
        } else if (lockFileNames.includes(entry.name)) {
            try {
                fs.unlinkSync(full);
                console.log(`🧹 Removed stale Chromium lock: ${full}`);
            } catch (e) {
                console.warn(`⚠️ Could not remove stale lock ${full}:`, e.message);
            }
        }
    }
}
clearStaleChromeLocks(authPath);

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        protocolTimeout: 120000
    },
    // Pins a known-stable WhatsApp Web version instead of auto-fetching
    // whatever's current. Without this, a version mismatch between the
    // fetched WA Web build and this Puppeteer/Chromium version causes a
    // page reload right after QR scan, which crashes Client.inject with
    // "Execution context was destroyed, most likely because of a navigation"
    // — a known unresolved whatsapp-web.js issue, not a bug in this code.
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023901613-alpha.html'
    }
});

const bootTime = Math.floor(Date.now() / 1000);
const msgLock = new Set(); 

client.on('qr', qr => {
    // Render's log viewer garbles dense terminal ASCII QR art, so instead of
    // relying on qrcode-terminal rendering correctly, print a link to a real
    // scannable QR image. Open the link in any browser and scan it normally.
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
    console.log('📱 SCAN THIS: open the link below in any browser, then scan the image with WhatsApp → Linked Devices → Link a Device');
    console.log(qrImageUrl);
    // Still print the terminal version too, in case it happens to render fine locally
    qrcode.generate(qr, { small: true });
});
client.on('ready', () => console.log('🚀 SYSTEM LIVE - KANBAN STATUS SHIELD ACTIVE'));

async function orchestrate(msg, isOutreach) {
    if (msg.timestamp < bootTime || msg.from.includes('status') || msg.from.endsWith('@g.us')) return;

    const phone = isOutreach ? msg.to : msg.from;
    const lockKey = `${msg.id.id}`; 
    if (msgLock.has(lockKey)) return;
    msgLock.add(lockKey);

    try {
        // 1. LEAD SERVICE: only engage inbound numbers that are already leads.
        // Cold inbound from a stranger who was never outreached gets ignored
        // completely — no new row, no reply. Outreach YOU send to a brand-new
        // number still creates the lead — otherwise you could never start a
        // new prospect.
        let { data: lead } = await supabase.from('leads').select('*').eq('phone', phone).maybeSingle();

        if (!lead && !isOutreach) {
            console.log(`⛔ Ignored inbound message from ${phone} — not an existing lead.`);
            msgLock.delete(lockKey);
            return;
        }

        if (!lead && isOutreach) {
            const { data: newLead } = await supabase.from('leads').insert({ phone, status: 'Outreach Sent' }).select().single();
            lead = newLead;
        }

        // 2. CONTEXT & STORAGE
        const { data: history } = await supabase.from('messages').select('body, from_me').eq('lead_id', lead.id).order('created_at', { ascending: false }).limit(6);
        await supabase.from('messages').insert({ id: msg.id.id, lead_id: lead.id, body: msg.body, from_me: isOutreach });

        // 3. DECISION ENGINE
        const knowledge = knowledgeService.getKnowledge();
        const decision = await decisionService.run(lead, (history || []).reverse(), msg.body, knowledge, isOutreach);
        console.log(`🔎 Lead ${lead.id} — ai_active read as: ${lead.ai_active} (isOutreach: ${isOutreach})`);

        // 4. KANBAN STATUS SHIELD (Business Rules)
        let nextStatus = lead.status;

        if (!isOutreach) {
            // LEAD REPLIED: Use pipeline rules to move forward
            nextStatus = pipelineService.calculateNextStatus(decision.intent, lead.status);
            console.log(`📡 LEAD REPLY: Moving status to [${nextStatus}]`);
        } else {
            // BOT/MANUAL SENT: 
            // Only set to 'Outreach Sent' if the lead is brand new (null or default)
            // If lead is already in 'Replied' or 'AI Qualifying', we DO NOT move it back.
            if (!lead.status || lead.status === 'Outreach Sent' || lead.status === 'Prospect') {
                nextStatus = 'Outreach Sent';
            } else {
                nextStatus = lead.status; // LOCK STATUS: Keep current position
            }
        }

        // 4b. BOOKING CONFIRMED — first time we see a concrete meeting_datetime_iso
        // for this lead, we log it to the in-house calendar and queue the success
        // video send. Checked in code (not left to the AI) so it can never fire twice.
        const alreadySentVideos = lead.memory?.video_sent === true;
        const isNewlyConfirmedBooking = decision.intent === 'BOOKING_CONFIRMED' && decision.meeting_datetime_iso && !alreadySentVideos;
        const isNewlySharedProcess = !!decision.new_facts?.sales_process && !lead.sales_process;

        // 5. SSOT UPDATE
        // .select() + explicit error/row-count check: without this, a blocked
        // update (RLS, constraint, etc.) returns no thrown error at all — just
        // 0 rows silently changed — and the bot would keep replying as if
        // nothing was wrong while the database quietly stopped updating.
        const { data: updatedLead, error: updateErr } = await supabase.from('leads').update({
            name: (lead.name === 'Prospect' || !lead.name) ? (decision.extracted_identity?.name || lead.name) : lead.name,
            industry: (lead.industry === 'Trade' || !lead.industry) ? (decision.extracted_identity?.industry || lead.industry) : lead.industry,
            location: (lead.location === 'Unknown' || !lead.location) ? (decision.extracted_identity?.location || lead.location) : lead.location,
            stat_info: (lead.stat_info === 'N/A' || !lead.stat_info) ? (decision.extracted_identity?.stats || lead.stat_info) : lead.stat_info,
            sales_process: lead.sales_process || decision.new_facts?.sales_process || null,
            // new_facts now always includes all 5 keys, with null for anything not
            // yet known — filter those out so we never clobber a fact we already
            // learned in an earlier message with a null from this one.
            memory: {
                ...lead.memory,
                ...Object.fromEntries(
                    Object.entries(decision.new_facts || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
                ),
                ...(isNewlyConfirmedBooking ? { video_sent: true } : {})
            },
            conv_state: decision.updated_state,
            status: nextStatus, // SHIELDED STATUS
            // SCORE SHIELD: never let a momentary low-engagement reply drag the score
            // back down once a lead has shown real buying intent.
            lead_score: Math.max(lead.lead_score || 0, decision.lead_score || 0),
            pain_points: decision.pain_points || lead.pain_points,
            last_message: msg.body,
            last_message_at: new Date().toISOString()
        }).eq('id', lead.id).select();

        if (updateErr || !updatedLead || updatedLead.length === 0) {
            console.error(`❌ SSOT UPDATE FAILED for lead ${lead.id} (${phone}):`, updateErr?.message || '0 rows updated — check RLS policies on leads.', updateErr?.details || '');
        }

        // 6. REPLY ACTION
        // Isolated in its own try/catch so a send failure (e.g. @lid contacts,
        // disconnected client) never gets swallowed by the outer catch without detail,
        // and never blocks the SSOT update above (which has already succeeded by this point).
        // Respects the ai_active flag: if a human has paused the AI for this lead
        // (via the toggle in LeadModal), skip the auto-reply entirely — the message,
        // facts, and status have already been recorded above, just no bot reply is sent.
        if (!isOutreach && lead.ai_active !== false && decision.reply && decision.reply !== "NONE") {
            try {
                // msg.reply() routes through the exact chat WhatsApp already associated
                // with this incoming message. This tends to handle @lid contacts (WhatsApp's
                // newer privacy-linked IDs) better than client.sendMessage(jid, ...) or
                // chat.sendMessage(), which can fail to resolve @lid send targets.
                const aiMsg = await msg.reply(decision.reply);

                // Some send paths (esp. @lid) can return a message object without a
                // populated id. Fall back to a generated id so logging never crashes.
                const aiMsgId = aiMsg?.id?.id || crypto.randomUUID();

                await supabase.from('messages').insert({ id: aiMsgId, lead_id: lead.id, body: decision.reply, from_me: true });
            } catch (sendErr) {
                // Log the full error object, not just .message — whatsapp-web.js errors
                // originate inside minified WhatsApp Web JS run via Puppeteer, so .message
                // alone is often a single meaningless letter. The full object/stack gives
                // more to go on.
                console.error(`❌ REPLY SEND FAILED for lead ${lead.id} (${phone}):`, sendErr);
            }
        } else if (!isOutreach && lead.ai_active === false) {
            console.log(`🤖⏸️  AI paused for lead ${lead.id} (${phone}) — reply skipped, human handling.`);
        }

        // 7. CALENDAR + SUCCESS VIDEOS
        // Fires once per lead, the first time a specific demo time is locked in.
        if (isNewlyConfirmedBooking) {
            const { error: bookingErr } = await supabase.from('bookings').insert({
                lead_id: lead.id,
                scheduled_at: decision.meeting_datetime_iso,
                status: 'confirmed'
            });
            if (bookingErr) console.error(`❌ BOOKING INSERT FAILED for lead ${lead.id}:`, bookingErr);
            else console.log(`📅 Booking confirmed for lead ${lead.id} at ${decision.meeting_datetime_iso}`);

            if (!isOutreach && lead.ai_active !== false) {
                const video1 = process.env.SUCCESS_VIDEO_URL_1;
                const video2 = process.env.SUCCESS_VIDEO_URL_2;
                if (!video1 || !video2) {
                    console.warn('⚠️ SUCCESS_VIDEO_URL_1 / SUCCESS_VIDEO_URL_2 not set in .env — skipping video send.');
                } else {
                    try {
                        const videoMsg = `Quick preview before we chat — here's how we've helped businesses like yours 🚀\n\n${video1}\n\n${video2}`;
                        const videoSendResult = await msg.reply(videoMsg);
                        const videoMsgId = videoSendResult?.id?.id || crypto.randomUUID();
                        await supabase.from('messages').insert({ id: videoMsgId, lead_id: lead.id, body: videoMsg, from_me: true });
                    } catch (videoErr) {
                        console.error(`❌ VIDEO SEND FAILED for lead ${lead.id} (${phone}):`, videoErr);
                    }
                }
            }
        }

        // 8. CASE STUDY VIDEO — fires once, right after we learn their current
        // sales process for the first time.
        if (isNewlySharedProcess && !isOutreach && lead.ai_active !== false) {
            const caseStudyUrl = process.env.CASE_STUDY_YOUTUBE_URL;
            if (!caseStudyUrl) {
                console.warn('⚠️ CASE_STUDY_YOUTUBE_URL not set in .env — skipping case study send.');
            } else {
                try {
                    const caseStudyMsg = `Thanks for sharing that! Here's a quick case study showing exactly how we've helped a business fix that 👇\n\n${caseStudyUrl}`;
                    const csResult = await msg.reply(caseStudyMsg);
                    const csMsgId = csResult?.id?.id || crypto.randomUUID();
                    await supabase.from('messages').insert({ id: csMsgId, lead_id: lead.id, body: caseStudyMsg, from_me: true });
                } catch (csErr) {
                    console.error(`❌ CASE STUDY SEND FAILED for lead ${lead.id} (${phone}):`, csErr);
                }
            }
        }

    } catch (e) { console.error("❌ CRITICAL ERROR:", e.message); }
    setTimeout(() => msgLock.delete(lockKey), 10000);
}

// Separated Listeners
// Both 'message' and 'message_create' can fire for the same message on
// @lid (WhatsApp privacy-linked ID) contacts, and worse — @lid messages you
// send yourself sometimes report msg.fromMe as false, so relying on "which
// event fired" to decide isOutreach is unreliable for these contacts.
// msg.id.fromMe is the more trustworthy field; fall back to msg.fromMe only
// if it's missing. orchestrate()'s own msgLock already de-dupes if both
// events fire for the same message id.
async function handleIncoming(m) {
    const isOutreach = m.id?.fromMe ?? m.fromMe;
    await orchestrate(m, isOutreach);
}

client.on('message', handleIncoming);
client.on('message_create', handleIncoming);

// This specific crash ("Execution context was destroyed, most likely because
// of a navigation") is a known, long-standing bug in whatsapp-web.js itself —
// it fires during the version-check step right as WhatsApp Web navigates from
// the QR screen to the chat interface. The underlying login usually actually
// succeeds; the library just mishandles this one timing race as fatal and lets
// it crash the whole Node process instead of retrying. So: catch it here and
// retry initialize automatically instead of dying.
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 5;

async function startClient() {
    initAttempts++;
    try {
        await client.initialize();
    } catch (err) {
        console.error(`❌ Client.initialize() failed (attempt ${initAttempts}/${MAX_INIT_ATTEMPTS}):`, err.message);
        if (initAttempts < MAX_INIT_ATTEMPTS) {
            const delayMs = 5000 * initAttempts;
            console.log(`🔁 Retrying initialize in ${delayMs / 1000}s...`);
            setTimeout(startClient, delayMs);
        } else {
            console.error('❌ Max init attempts reached. Exiting so the host restarts the container fresh.');
            process.exit(1);
        }
    }
}

// Belt-and-suspenders: this exact bug throws asynchronously in a way that can
// bypass the try/catch above and hit Node's uncaughtException handler instead.
// Without this handler, that kills the whole process immediately.
process.on('uncaughtException', (err) => {
    if (err.message?.includes('Execution context was destroyed')) {
        console.error('⚠️ Caught known whatsapp-web.js navigation-timing crash — retrying instead of exiting:', err.message);
        if (initAttempts < MAX_INIT_ATTEMPTS) {
            setTimeout(startClient, 5000 * initAttempts);
        } else {
            process.exit(1);
        }
    } else {
        console.error('❌ UNCAUGHT EXCEPTION:', err);
        process.exit(1);
    }
});

startClient();