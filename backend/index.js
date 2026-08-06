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

// --- 1. START SERVER IMMEDIATELY (Satisfies Render Health Check) ---
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
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f4f4f9;">
                    <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;">
                        <h2>Scan WhatsApp QR</h2>
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQr)}" />
                        <p style="color:#666;margin-top:20px;">The page refreshes every 20s to show the latest code.</p>
                        <p>Status: <b>${clientStatus}</b></p>
                    </div>
                    <script>setTimeout(() => location.reload(), 20000);</script>
                </body>
            </html>
        `);
    } else {
        res.send(`<h1>Engine Starting...</h1><p>Status: ${clientStatus}</p><p>Please wait 30s for QR code...</p><script>setTimeout(() => location.reload(), 5000);</script>`);
    }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Render Port ${port} opened immediately.`));

// --- 2. INITIALIZE CLIENT ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Render-safe Chrome path
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

client.on('qr', (qr) => {
    latestQr = qr;
    clientStatus = "Awaiting Scan";
    qrcode.generate(qr, { small: true });
    console.log('👉 NEW QR CODE READY AT URL');
});

client.on('ready', () => {
    latestQr = "";
    clientStatus = "READY";
    console.log('✅ AGENTIC ENGINE ONLINE');
});

client.on('auth_failure', (msg) => {
    clientStatus = "Auth Failure - Refreshing QR";
    console.error('AUTHENTICATION FAILURE', msg);
});

// --- 3. YOUR BUSINESS LOGIC (Unchanged) ---
async function orchestrate(msg, isOutreach) {
    const bootTime = Math.floor(Date.now() / 1000);
    const msgLock = new Set();
    if (msg.timestamp < (Date.now() / 1000) - 60) return;
    if (msg.from.includes('status') || msg.from.endsWith('@g.us')) return;

    const phone = isOutreach ? msg.to : msg.from;
    const lockKey = `${msg.id.id}`; 
    if (msgLock.has(lockKey)) return;
    msgLock.add(lockKey);

    try {
        let { data: lead } = await supabase.from('leads').select('*').eq('phone', phone).maybeSingle();
        if (!lead && !isOutreach) { msgLock.delete(lockKey); return; }
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
            memory: { ...lead.memory, ...decision.new_facts },
            conv_state: decision.updated_state,
            status: nextStatus,
            last_message: msg.body,
            last_message_at: new Date().toISOString()
        }).eq('id', lead.id);

        if (!isOutreach && decision.reply && decision.reply !== "NONE") {
            const aiMsg = await client.sendMessage(msg.from, decision.reply);
            await supabase.from('messages').insert({ id: aiMsg.id.id, lead_id: lead.id, body: decision.reply, from_me: true });
        }
    } catch (e) { console.error("❌ ERROR:", e.message); }
}

client.on('message', async (m) => { if (!m.fromMe) await orchestrate(m, false); });
client.on('message_create', async (m) => { if (m.fromMe) await orchestrate(m, true); });

client.initialize();