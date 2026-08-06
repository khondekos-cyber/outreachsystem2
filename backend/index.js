const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const fs = require('fs');
require('dotenv').config();

const decisionService = require('./services/decisionService');
const knowledgeService = require('./services/knowledgeService');
const pipelineService = require('./services/pipelineService');

// --- 1. RENDER WEB SERVER (Prevents Timeout & Hosts QR) ---
const app = express();
const port = process.env.PORT || 10000;
let latestQr = "";
let clientStatus = "Initializing...";

app.get('/', (req, res) => {
    if (clientStatus === "READY") {
        res.send('<h1>✅ Engine Online</h1><p>WhatsApp is connected and SSOT is active.</p>');
    } else if (latestQr) {
        res.send(`
            <html>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#f8fafc;font-family:sans-serif;">
                    <div style="background:white;padding:40px;border-radius:30px;box-shadow:0 10px 25px rgba(0,0,0,0.05);text-align:center;">
                        <h1 style="margin-bottom:20px;">Scan WhatsApp QR</h1>
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQr)}" />
                        <p style="color:#64748b;margin-top:20px;">The page refreshes every 20s to show the latest code.</p>
                        <p>Status: <b>${clientStatus}</b></p>
                    </div>
                    <script>setTimeout(() => location.reload(), 20000);</script>
                </body>
            </html>
        `);
    } else {
        res.send('<h1>Engine Starting...</h1><p>Wait 30s and refresh.</p><script>setTimeout(() => location.reload(), 5000);</script>');
    }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Web server live on port ${port}`));

// --- 2. CHROMIUM LOCK FIX (Kills "Profile in use" error) ---
const sessionPath = path.join(process.cwd(), '.wwebjs_auth', 'session', 'Default', 'SingletonLock');
if (fs.existsSync(sessionPath)) {
    try {
        fs.unlinkSync(sessionPath);
        console.log('🔓 Removed old Chromium lock file');
    } catch (e) {
        console.error('⚠️ Could not remove lock file', e.message);
    }
}

// --- 3. INITIALIZATION ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const chromePath = path.join(process.cwd(), '.puppeteer', 'chrome', 'linux-146.0.7680.31', 'chrome-linux64', 'chrome');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote'
        ],
        executablePath: process.env.NODE_ENV === 'production' ? chromePath : undefined
    }
});

const bootTime = Math.floor(Date.now() / 1000);
const msgLock = new Set(); 

client.on('qr', (qr) => {
    latestQr = qr;
    clientStatus = "Awaiting Scan";
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    latestQr = "";
    clientStatus = "READY";
    console.log('✅ AGENTIC ENGINE ONLINE');
});

// --- 4. SSOT LOGIC ---
async function orchestrate(msg, isOutreach) {
    if (msg.timestamp < bootTime || msg.from.includes('status') || msg.from.endsWith('@g.us')) return;

    const phone = isOutreach ? msg.to : msg.from;
    const lockKey = `${msg.id.id}`; 
    if (msgLock.has(lockKey)) return;
    msgLock.add(lockKey);

    try {
        let { data: lead } = await supabase.from('leads').select('*').eq('phone', phone).maybeSingle();

        if (!lead && !isOutreach) {
            msgLock.delete(lockKey);
            return;
        }

        if (!lead && isOutreach) {
            const { data: newLead } = await supabase.from('leads').insert({ phone, status: 'Outreach Sent' }).select().single();
            lead = newLead;
        }

        const { data: history } = await supabase.from('messages').select('body, from_me').eq('lead_id', lead.id).order('created_at', { ascending: false }).limit(6);
        await supabase.from('messages').insert({ id: msg.id.id, lead_id: lead.id, body: msg.body, from_me: isOutreach });

        const knowledge = knowledgeService.getKnowledge();
        const decision = await decisionService.run(lead, (history || []).reverse(), msg.body, knowledge, isOutreach);

        let nextStatus = lead.status;
        if (isOutreach) {
            if (!lead.status || lead.status === 'Outreach Sent' || lead.status === 'Prospect') nextStatus = 'Outreach Sent';
        } else {
            nextStatus = pipelineService.calculateNextStatus(decision.intent, lead.status);
        }

        await supabase.from('leads').update({
            name: (lead.name === 'Prospect' || !lead.name) ? (decision.extracted_identity?.name || lead.name) : lead.name,
            industry: (lead.industry === 'Trade' || !lead.industry) ? (decision.extracted_identity?.industry || lead.industry) : lead.industry,
            location: (lead.location === 'Unknown' || !lead.location) ? (decision.extracted_identity?.location || lead.location) : lead.location,
            stat_info: (lead.stat_info === 'N/A' || !lead.stat_info) ? (decision.extracted_identity?.stats || lead.stat_info) : lead.stat_info,
            sales_process: lead.sales_process || decision.new_facts?.sales_process || null,
            memory: {
                ...lead.memory,
                ...Object.fromEntries(Object.entries(decision.new_facts || {}).filter(([, v]) => v !== null && v !== undefined && v !== ''))
            },
            conv_state: decision.updated_state,
            status: nextStatus,
            lead_score: Math.max(lead.lead_score || 0, decision.lead_score || 0),
            pain_points: decision.pain_points || lead.pain_points,
            last_message: msg.body,
            last_message_at: new Date().toISOString()
        }).eq('id', lead.id);

        if (!isOutreach && lead.ai_active !== false && decision.reply && decision.reply !== "NONE") {
            try {
                const aiMsg = await msg.reply(decision.reply);
                const aiMsgId = aiMsg?.id?.id || crypto.randomUUID();
                await supabase.from('messages').insert({ id: aiMsgId, lead_id: lead.id, body: decision.reply, from_me: true });
            } catch (sendErr) { console.error("❌ Send Fail", sendErr); }
        }

    } catch (e) { console.error("❌ Engine Fault", e.message); }
    setTimeout(() => msgLock.delete(lockKey), 10000);
}

async function handleIncoming(m) {
    const isOutreach = m.id?.fromMe ?? m.fromMe;
    await orchestrate(m, isOutreach);
}

client.on('message', handleIncoming);
client.on('message_create', handleIncoming);

client.initialize();