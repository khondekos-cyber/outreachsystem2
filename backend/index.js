const { Client, LocalAuth } = require('whatsapp-web.js'); // FIXED: Import Client
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
require('dotenv').config();

// Load Services
const decisionService = require('./services/decisionService');
const knowledgeService = require('./services/knowledgeService');
const pipelineService = require('./services/pipelineService');

// 1. RENDER HEALTH CHECK (Required)
const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Engine Alive'));
app.listen(port, '0.0.0.0', () => console.log(`🚀 Health check on port ${port}`));

// 2. SUPABASE INITIALIZATION
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 3. PUPPETEER CONFIG (RENDER COMPATIBLE)
const chromePath = path.join(process.cwd(), '.puppeteer', 'chrome', 'linux-146.0.7680.31', 'chrome-linux64', 'chrome');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'],
        executablePath: process.env.NODE_ENV === 'production' ? chromePath : undefined
    }
});

const bootTime = Math.floor(Date.now() / 1000);
const msgLock = new Set();

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ AGENTIC ENGINE ONLINE'));

/**
 * CORE ORCHESTRATION LOGIC
 */
async function orchestrate(msg, isOutreach) {
    if (msg.timestamp < bootTime || msg.from.includes('status') || msg.from.endsWith('@g.us')) return;

    const phone = isOutreach ? msg.to : msg.from;
    const lockKey = `${msg.id.id}`; 
    if (msgLock.has(lockKey)) return;
    msgLock.add(lockKey);

    try {
        // 1. Lead Retrieval
        let { data: lead } = await supabase.from('leads').select('*').eq('phone', phone).maybeSingle();

        if (!lead && !isOutreach) {
            msgLock.delete(lockKey);
            return;
        }

        if (!lead && isOutreach) {
            const { data: newLead } = await supabase.from('leads').insert({ phone, status: 'Outreach Sent' }).select().single();
            lead = newLead;
        }

        // 2. History & Logging
        const { data: history } = await supabase.from('messages').select('body, from_me').eq('lead_id', lead.id).order('created_at', { ascending: false }).limit(6);
        await supabase.from('messages').insert({ id: msg.id.id, lead_id: lead.id, body: msg.body, from_me: isOutreach });

        // 3. Decision
        const knowledge = knowledgeService.getKnowledge();
        const decision = await decisionService.run(lead, (history || []).reverse(), msg.body, knowledge, isOutreach);

        // 4. Status Shield
        let nextStatus = lead.status;
        if (isOutreach) {
            if (!lead.status || lead.status === 'Outreach Sent') nextStatus = 'Outreach Sent';
        } else {
            nextStatus = pipelineService.calculateNextStatus(decision.intent, lead.status);
        }

        // 5. Update SSOT
        await supabase.from('leads').update({
            name: (lead.name === 'Prospect' || !lead.name) ? decision.extracted_identity.name : lead.name,
            industry: (lead.industry === 'Trade' || !lead.industry) ? decision.extracted_identity.industry : lead.industry,
            location: (lead.location === 'Unknown' || !lead.location) ? decision.extracted_identity.location : lead.location,
            stat_info: lead.stat_info || decision.extracted_identity.stats,
            memory: { ...lead.memory, ...decision.new_facts },
            conv_state: decision.updated_state,
            status: nextStatus,
            last_message: msg.body,
            last_message_at: new Date().toISOString()
        }).eq('id', lead.id);

        // 6. Reply
        if (!isOutreach && decision.reply && decision.reply !== "NONE") {
            const aiMsg = await client.sendMessage(msg.from, decision.reply);
            await supabase.from('messages').insert({ id: aiMsg.id.id, lead_id: lead.id, body: decision.reply, from_me: true });
        }

    } catch (e) { console.error("⚠️ Error:", e.message); }
    setTimeout(() => msgLock.delete(lockKey), 10000);
}

client.on('message', async (m) => { if (!m.fromMe) await orchestrate(m, false); });
client.on('message_create', async (m) => { if (m.fromMe) await orchestrate(m, true); });

client.initialize();