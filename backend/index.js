const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
require('dotenv').config();

const decisionService = require('./services/decisionService');
const knowledgeService = require('./services/knowledgeService');
const pipelineService = require('./services/pipelineService');

// 1. RENDER HEALTH CHECK & PORT BINDING
const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Engine Alive'));
app.listen(port, '0.0.0.0', () => console.log(`🚀 Render health check on port ${port}`));

// 2. SUPABASE INITIALIZATION
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 3. STABLE PUPPETEER CONFIG FOR RENDER
// Ensure your Build Command installs chrome to this path
const chromePath = path.join(process.cwd(), '.puppeteer', 'chrome', 'linux-146.0.7680.31', 'chrome-linux64', 'chrome');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process'
        ],
        executablePath: process.env.NODE_ENV === 'production' ? chromePath : undefined
    }
});

const bootTime = Math.floor(Date.now() / 1000);
const msgLock = new Set(); 

// 4. QR GENERATION (Terminal + URL Link)
client.on('qr', (qr) => {
    // Standard terminal QR
    qrcode.generate(qr, { small: true });
    
    // CLICKABLE URL FOR RENDER LOGS
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
    console.log('------------------------------------------------------------');
    console.log('👉 CANNOT SCAN TERMINAL? CLICK THIS LINK FOR THE QR CODE:');
    console.log(qrUrl);
    console.log('------------------------------------------------------------');
});

client.on('ready', () => console.log('🚀 SYSTEM LIVE - KANBAN STATUS SHIELD ACTIVE'));

/**
 * THE SSOT ORCHESTRATOR (Your Specific Logic)
 */
async function orchestrate(msg, isOutreach) {
    if (msg.timestamp < bootTime || msg.from.includes('status') || msg.from.endsWith('@g.us')) return;

    const phone = isOutreach ? msg.to : msg.from;
    const lockKey = `${msg.id.id}`; 
    if (msgLock.has(lockKey)) return;
    msgLock.add(lockKey);

    try {
        // 1. LEAD SERVICE
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

        // 4. KANBAN STATUS SHIELD
        let nextStatus = lead.status;

        if (!isOutreach) {
            nextStatus = pipelineService.calculateNextStatus(decision.intent, lead.status);
            console.log(`📡 LEAD REPLY: Moving status to [${nextStatus}]`);
        } else {
            if (!lead.status || lead.status === 'Outreach Sent' || lead.status === 'Prospect') {
                nextStatus = 'Outreach Sent';
            } else {
                nextStatus = lead.status; 
            }
        }

        // 4b. BOOKING CONFIRMED Logic
        const alreadySentVideos = lead.memory?.video_sent === true;
        const isNewlyConfirmedBooking = decision.intent === 'BOOKING_CONFIRMED' && decision.meeting_datetime_iso && !alreadySentVideos;
        const isNewlySharedProcess = !!decision.new_facts?.sales_process && !lead.sales_process;

        // 5. SSOT UPDATE
        const { data: updatedLead, error: updateErr } = await supabase.from('leads').update({
            name: (lead.name === 'Prospect' || !lead.name) ? (decision.extracted_identity?.name || lead.name) : lead.name,
            industry: (lead.industry === 'Trade' || !lead.industry) ? (decision.extracted_identity?.industry || lead.industry) : lead.industry,
            location: (lead.location === 'Unknown' || !lead.location) ? (decision.extracted_identity?.location || lead.location) : lead.location,
            stat_info: (lead.stat_info === 'N/A' || !lead.stat_info) ? (decision.extracted_identity?.stats || lead.stat_info) : lead.stat_info,
            sales_process: lead.sales_process || decision.new_facts?.sales_process || null,
            memory: {
                ...lead.memory,
                ...Object.fromEntries(
                    Object.entries(decision.new_facts || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
                ),
                ...(isNewlyConfirmedBooking ? { video_sent: true } : {})
            },
            conv_state: decision.updated_state,
            status: nextStatus,
            lead_score: Math.max(lead.lead_score || 0, decision.lead_score || 0),
            pain_points: decision.pain_points || lead.pain_points,
            last_message: msg.body,
            last_message_at: new Date().toISOString()
        }).eq('id', lead.id).select();

        if (updateErr || !updatedLead || updatedLead.length === 0) {
            console.error(`❌ SSOT UPDATE FAILED for lead ${lead.id}:`, updateErr?.message || '0 rows updated');
        }

        // 6. REPLY ACTION
        if (!isOutreach && lead.ai_active !== false && decision.reply && decision.reply !== "NONE") {
            try {
                const aiMsg = await msg.reply(decision.reply);
                const aiMsgId = aiMsg?.id?.id || crypto.randomUUID();
                await supabase.from('messages').insert({ id: aiMsgId, lead_id: lead.id, body: decision.reply, from_me: true });
            } catch (sendErr) {
                console.error(`❌ REPLY SEND FAILED for lead ${lead.id}:`, sendErr);
            }
        }

        // 7. CALENDAR + SUCCESS VIDEOS
        if (isNewlyConfirmedBooking) {
            await supabase.from('bookings').insert({
                lead_id: lead.id,
                scheduled_at: decision.meeting_datetime_iso,
                status: 'confirmed'
            });

            if (!isOutreach && lead.ai_active !== false) {
                const video1 = process.env.SUCCESS_VIDEO_URL_1;
                const video2 = process.env.SUCCESS_VIDEO_URL_2;
                if (video1 && video2) {
                    const videoMsg = `Quick preview before we chat — here's how we've helped businesses like yours 🚀\n\n${video1}\n\n${video2}`;
                    const videoSendResult = await msg.reply(videoMsg);
                    const videoMsgId = videoSendResult?.id?.id || crypto.randomUUID();
                    await supabase.from('messages').insert({ id: videoMsgId, lead_id: lead.id, body: videoMsg, from_me: true });
                }
            }
        }

        // 8. CASE STUDY VIDEO
        if (isNewlySharedProcess && !isOutreach && lead.ai_active !== false) {
            const caseStudyUrl = process.env.CASE_STUDY_YOUTUBE_URL;
            if (caseStudyUrl) {
                const caseStudyMsg = `Thanks for sharing that! Here's a quick case study showing exactly how we've helped a business fix that 👇\n\n${caseStudyUrl}`;
                const csResult = await msg.reply(caseStudyMsg);
                const csMsgId = csResult?.id?.id || crypto.randomUUID();
                await supabase.from('messages').insert({ id: csMsgId, lead_id: lead.id, body: caseStudyMsg, from_me: true });
            }
        }

    } catch (e) { console.error("❌ CRITICAL ERROR:", e.message); }
    setTimeout(() => msgLock.delete(lockKey), 10000);
}

async function handleIncoming(m) {
    const isOutreach = m.id?.fromMe ?? m.fromMe;
    await orchestrate(m, isOutreach);
}

client.on('message', handleIncoming);
client.on('message_create', handleIncoming);

client.initialize();