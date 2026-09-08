require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const decisionService = require('./services/decisionService');
const knowledgeService = require('./services/knowledgeService');
const pipelineService = require('./services/pipelineService');
const eventService = require('./services/eventService');

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let sock;
let currentQrBase64 = null;
let isConnected = false;

// 60s TTL Message De-duplication Cache
const processedMessageIds = new Map();
function isDuplicateMessage(msgId) {
    if (!msgId) return false;
    const now = Date.now();
    if (processedMessageIds.has(msgId)) return true;
    processedMessageIds.set(msgId, now);
    for (const [id, time] of processedMessageIds.entries()) {
        if (now - time > 60000) processedMessageIds.delete(id);
    }
    return false;
}

// 🛡️ Bulletproof Lead Matcher (Pure Numeric + Name Recognition)
async function findExistingLead(remoteJid, messageBody = "") {
    try {
        // 1. Extract pure numbers from remoteJid (e.g. "52016734806118" from "52016734806118:2@lid")
        const rawDigits = (remoteJid || "").replace(/[^0-9]/g, "");
        
        if (rawDigits.length >= 7) {
            const { data: leadsByPhone } = await supabase
                .from('leads')
                .select('*')
                .ilike('phone', `%${rawDigits}%`)
                .limit(1);

            if (leadsByPhone && leadsByPhone.length > 0) {
                return leadsByPhone[0];
            }
        }

        // 2. Direct exact match on remoteJid string
        const { data: leadsByJid } = await supabase
            .from('leads')
            .select('*')
            .eq('phone', remoteJid)
            .limit(1);

        if (leadsByJid && leadsByJid.length > 0) {
            return leadsByJid[0];
        }

        // 3. Name Match in Greeting (e.g. "Hey I'Themba Lethu", "Hey CJ Waterproofing")
        if (messageBody && messageBody.length > 4) {
            const { data: allActiveLeads } = await supabase
                .from('leads')
                .select('*')
                .limit(150);

            if (allActiveLeads && allActiveLeads.length > 0) {
                const lowerBody = messageBody.toLowerCase();
                const matched = allActiveLeads.find(l => 
                    l.name && 
                    l.name !== 'New Prospect' && 
                    lowerBody.includes(l.name.toLowerCase().trim())
                );
                if (matched) {
                    console.log(`🎯 [NAME MATCH] Message matched lead: "${matched.name}"`);
                    return matched;
                }
            }
        }
    } catch (e) {
        console.error('Lead lookup error:', e.message);
    }
    return null;
}

// ==========================================
// BAILEYS WHATSAPP CLIENT
// ==========================================
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    currentQrBase64 = url;
                    io.emit('qr', url);
                }
            });
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Connection closed (${statusCode}), reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            isConnected = true;
            currentQrBase64 = null;
            console.log('✅ Baileys WhatsApp client is CONNECTED and LISTENING');
            io.emit('ready');
            setTimeout(runFollowUpSweep, 3000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || !msg.key) continue;
            if (isDuplicateMessage(msg.key.id)) continue;

            const remoteJid = msg.key.remoteJid;
            // Strictly ignore group chats and status broadcasts
            if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) continue;

            const cleanPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
            const body = msg.message.conversation ||
                         msg.message.extendedTextMessage?.text ||
                         msg.message.imageMessage?.caption || '';

            if (!body.trim()) continue;
            const isOutbound = msg.key.fromMe;
            const knowledge = knowledgeService.getKnowledge();

            // ========================================================
            // FLOW 1: OUTBOUND MESSAGES (You texting from your phone)
            // ========================================================
            if (isOutbound) {
                // 🚪 DOOR A: Is this an existing lead in the database?
                const existingLead = await findExistingLead(remoteJid, body);

                if (existingLead) {
                    // Log message in history
                    await supabase.from('messages').insert({ lead_id: existingLead.id, body: body, from_me: true });

                    // 🎯 MOVE TO "Follow-Up Sent"
                    const followupStages = ['Follow-Up Due', 'Outreach Sent', 'Follow-Up Sent'];
                    if (followupStages.includes(existingLead.status)) {
                        const newCount = (existingLead.followup_count || 0) + 1;
                        await supabase.from('leads').update({
                            status: 'Follow-Up Sent',
                            pending_draft: null,
                            draft_stage: null,
                            followup_count: newCount,
                            last_message_at: new Date().toISOString()
                        }).eq('id', existingLead.id);

                        await eventService.log(existingLead.id, 'FOLLOWUP_SENT', `Follow-Up #${newCount} sent to ${existingLead.name}`, { body });
                        console.log(`🚀 [SUCCESS] ${existingLead.name} moved ➔ "Follow-Up Sent" (Step #${newCount})`);
                        io.emit('lead_updated', { lead_id: existingLead.id, status: 'Follow-Up Sent' });
                    } else {
                        await supabase.from('leads').update({ last_message_at: new Date().toISOString() }).eq('id', existingLead.id);
                        io.emit('message_received', { lead_id: existingLead.id });
                    }
                    continue; // 🛑 STRICT STOP: Never check cold pitch analyzer for existing leads!
                }

                // 🚪 DOOR B: Brand-new stranger -> Check if this is a fresh cold pitch to ingest
                console.log(`🔍 [ANALYZING COLD OUTREACH] "${body}" to ${cleanPhone}`);
                const decision = await decisionService.run({}, [], body, knowledge, true);

                if (decision.intent !== 'OUTREACH') {
                    console.log(`⏭️ [SKIPPED CASUAL TEXT] Not a business pitch.`);
                    continue;
                }

                // Ingest new Lead into Database
                const { data: newLead, error: insertErr } = await supabase
                    .from('leads')
                    .insert({
                        phone: remoteJid,
                        name: decision.extracted_identity?.name || 'New Prospect',
                        industry: decision.extracted_identity?.industry || null,
                        location: decision.extracted_identity?.location || null,
                        stat_info: decision.extracted_identity?.stats || null,
                        status: 'Outreach Sent',
                        memory: {},
                        conv_state: { stage: 'Outreach Sent', goal: 'Awaiting Reply' },
                        lead_score: 10,
                        followup_count: 0,
                        ai_active: true
                    })
                    .select()
                    .single();

                if (insertErr) {
                    console.error('❌ Supabase insert error:', insertErr.message);
                    continue;
                }

                await supabase.from('messages').insert({ lead_id: newLead.id, body: body, from_me: true });
                await eventService.log(newLead.id, 'OUTREACH', `Outreach pitch sent to ${newLead.name}`, { identity: decision.extracted_identity });
                console.log(`✅ [INGESTED LEAD] ${newLead.name} locked into SSOT.`);

                io.emit('lead_updated', { lead_id: newLead.id, status: 'Outreach Sent' });
                continue;
            }

            // ========================================================
            // FLOW 2: INBOUND LEAD REPLIES (Lead texting you)
            // ========================================================
            try {
                const lead = await findExistingLead(remoteJid, body);

                if (!lead) {
                    console.log(`🚫 [IGNORED UNREGISTERED SENDER] ${remoteJid}`);
                    continue;
                }

                console.log(`📩 Inbound reply from ${lead.name || lead.phone}: "${body}"`);

                // 1. Log incoming message
                await supabase.from('messages').insert({ lead_id: lead.id, body: body, from_me: false });
                io.emit('message_received', { lead_id: lead.id });

                // 2. 🛑 ABSOLUTE HARD KILL-SWITCH: If Manual Mode, STOP HERE IMMEDIATELY.
                if (lead.ai_active === false) {
                    console.log(`🛑 [MANUAL TAKEOVER HARD STOP] AI is OFF for ${lead.name}. No AI call made.`);
                    await supabase.from('leads').update({ last_message_at: new Date().toISOString() }).eq('id', lead.id);
                    io.emit('lead_updated', { lead_id: lead.id, manual_attention: true });
                    continue; // 🛑 Strict Stop
                }

                // 3. Fetch past 20 messages for AI context
                const { data: history } = await supabase
                    .from('messages')
                    .select('body, from_me, created_at')
                    .eq('lead_id', lead.id)
                    .order('created_at', { ascending: true })
                    .limit(20);

                // 4. Run Decision Engine
                const decision = await decisionService.run(lead, history || [], body, knowledge, false);
                const nextStatus = pipelineService.calculateNextStatus(decision.intent, lead.status || 'Replied');

                let memoryObj = {};
                if (typeof lead.memory === 'string') {
                    try { memoryObj = JSON.parse(lead.memory); } catch (e) { memoryObj = {}; }
                } else if (typeof lead.memory === 'object' && lead.memory !== null) {
                    memoryObj = { ...lead.memory };
                }

                if (decision.new_facts) {
                    Object.entries(decision.new_facts).forEach(([k, v]) => {
                        if (v && v !== 'string or null' && v !== 'null') memoryObj[k] = v;
                    });
                }
                if (decision.meeting_datetime_iso) memoryObj.meeting_time = decision.meeting_datetime_iso;

                await supabase.from('leads').update({
                    name: (decision.extracted_identity?.name && decision.extracted_identity.name !== "New Prospect") ? decision.extracted_identity.name : lead.name,
                    industry: decision.extracted_identity?.industry || lead.industry,
                    location: decision.extracted_identity?.location || lead.location,
                    stat_info: decision.extracted_identity?.stats || lead.stat_info,
                    status: nextStatus,
                    memory: memoryObj,
                    conv_state: decision.updated_state || lead.conv_state,
                    lead_score: decision.lead_score ?? lead.lead_score,
                    pain_points: decision.pain_points || lead.pain_points,
                    sales_process: decision.new_facts?.sales_process || lead.sales_process,
                    pending_draft: null,
                    last_message_at: new Date().toISOString()
                }).eq('id', lead.id);

                if (decision.intent === 'BOOKING_CONFIRMED' && decision.meeting_datetime_iso) {
                    const { data: existingBooking } = await supabase.from('bookings').select('id').eq('lead_id', lead.id).limit(1);
                    if (existingBooking && existingBooking.length > 0) {
                        await supabase.from('bookings').update({ scheduled_at: decision.meeting_datetime_iso, status: 'confirmed' }).eq('id', existingBooking[0].id);
                    } else {
                        await supabase.from('bookings').insert({ lead_id: lead.id, scheduled_at: decision.meeting_datetime_iso, status: 'confirmed' });
                    }
                }

                await eventService.log(lead.id, decision.intent, `Moved [${lead.status}] ➔ [${nextStatus}]`, { intent: decision.intent, facts: decision.new_facts });

                // Send WhatsApp Reply via Baileys
                if (decision.reply && decision.reply !== "None" && decision.reply.trim() !== "") {
                    await new Promise(r => setTimeout(r, 1200));
                    await sock.sendMessage(remoteJid, { text: decision.reply });
                    await supabase.from('messages').insert({ lead_id: lead.id, body: decision.reply, from_me: true });
                }

                io.emit('lead_updated', { lead_id: lead.id, status: nextStatus, lead_score: decision.lead_score });
            } catch (err) {
                console.error('❌ Inbound pipeline error:', err);
            }
        }
    });
}

// =========================================================================
// 48H ➔ 7D ➔ 14D FOLLOW-UP SWEEP ENGINE
// =========================================================================
async function runFollowUpSweep() {
    console.log('🔄 [SWEEP] Evaluating 48h / 7d / 14d follow-up cadence...');
    const now = Date.now();
    const knowledge = knowledgeService.getKnowledge();

    const activeStages = ['Outreach Sent', 'Follow-Up Sent', 'Replied', 'AI Qualifying', 'Interested / Demo', 'Follow-Up Due'];

    const { data: leads, error } = await supabase
        .from('leads')
        .select('*')
        .in('status', activeStages)
        .neq('status', 'Lost / Ghosted');

    if (error || !leads) return;

    for (const lead of leads) {
        const lastMsgTime = new Date(lead.last_message_at || lead.created_at).getTime();
        let diffHours = (now - lastMsgTime) / (1000 * 60 * 60);

        if (diffHours < 0 || isNaN(diffHours)) diffHours = 72; // Year 2026 test-data fallback

        const count = lead.followup_count || 0;

        let targetStage = null;
        if (count === 0 && diffHours >= 48) targetStage = '48H_NUDGE';
        else if (count === 1 && diffHours >= 168) targetStage = '7D_ASSET';   // 7 days = 168 hours
        else if (count === 2 && diffHours >= 336) targetStage = '14D_BREAKUP'; // 14 days = 336 hours
        else if (count >= 3 && diffHours >= 336) {
            await supabase.from('leads').update({ status: 'Lost / Ghosted', ai_active: false }).eq('id', lead.id);
            io.emit('lead_updated', { lead_id: lead.id, status: 'Lost / Ghosted' });
            continue;
        }

        if (targetStage && !lead.pending_draft) {
            const { data: history } = await supabase
                .from('messages')
                .select('body, from_me')
                .eq('lead_id', lead.id)
                .order('created_at', { ascending: true });

            console.log(`🤖 Staging [${targetStage}] draft for ${lead.name}...`);
            const { draft } = await decisionService.generateFollowUp(lead, history || [], targetStage, knowledge);

            await supabase.from('leads').update({
                pending_draft: draft,
                draft_stage: targetStage,
                status: 'Follow-Up Due'
            }).eq('id', lead.id);

            io.emit('lead_updated', { lead_id: lead.id, status: 'Follow-Up Due' });
        }
    }
    console.log('🏁 [SWEEP COMPLETE]');
}

setInterval(runFollowUpSweep, 60 * 60 * 1000);

// REST APIs
app.post('/api/trigger-sweep', async (req, res) => {
    runFollowUpSweep();
    res.json({ success: true, message: 'Sweep started' });
});

app.post('/api/mark-followup-sent', async (req, res) => {
    const { leadId } = req.body;
    if (!leadId) return res.status(400).json({ error: 'Missing leadId' });

    try {
        const { data: lead } = await supabase.from('leads').select('*').eq('id', leadId).single();
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        const newCount = (lead.followup_count || 0) + 1;
        await supabase.from('leads').update({
            status: 'Follow-Up Sent',
            pending_draft: null,
            draft_stage: null,
            followup_count: newCount,
            last_message_at: new Date().toISOString()
        }).eq('id', leadId);

        await eventService.log(lead.id, 'FOLLOWUP_SENT', `Follow-Up #${newCount} marked as sent for ${lead.name}`);
        io.emit('lead_updated', { lead_id: leadId, status: 'Follow-Up Sent' });
        res.json({ success: true, followup_count: newCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/send-message', async (req, res) => {
    const { leadId, body } = req.body;
    if (!leadId || !body || !sock) return res.status(400).json({ error: 'WhatsApp not connected' });

    try {
        const { data: lead } = await supabase.from('leads').select('phone').eq('id', leadId).single();
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        await sock.sendMessage(lead.phone, { text: body });
        await supabase.from('messages').insert({ lead_id: leadId, body, from_me: true });
        await supabase.from('leads').update({ last_message_at: new Date().toISOString() }).eq('id', leadId);

        io.emit('message_received', { lead_id: leadId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/qr', (req, res) => {
    if (isConnected) return res.send('<h2 style="font-family:sans-serif;color:green;text-align:center;margin-top:50px;">✅ WhatsApp Connected!</h2>');
    if (!currentQrBase64) return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">⏳ Generating QR...</h2><script>setTimeout(()=>location.reload(),3000);</script>');
    res.send(`<div style="display:flex;justify-content:center;align-items:center;height:90vh;"><img src="${currentQrBase64}" style="width:300px;border-radius:16px;"/></div>`);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Fact-Bank Server listening on port ${PORT}`);
    startWhatsApp();
    setTimeout(runFollowUpSweep, 3000);
});
