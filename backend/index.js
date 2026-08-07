const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const express = require('express');
const fs = require('fs');
require('dotenv').config();

const decisionService = require('./services/decisionService');
const knowledgeService = require('./services/knowledgeService');
const pipelineService = require('./services/pipelineService');

// --- 1. RENDER WEB SERVER ---
const app = express();
const port = process.env.PORT || 10000;
let latestQr = "";
let clientStatus = "Initializing...";

app.get('/', (req, res) => {
    if (clientStatus === "READY") {
        res.send('<h1>✅ Engine Online</h1><p>Connected to WhatsApp.</p>');
    } else if (latestQr) {
        res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#f8fafc;font-family:sans-serif;"><div style="background:white;padding:40px;border-radius:30px;box-shadow:0 10px 25px rgba(0,0,0,0.05);text-align:center;"><h1>Scan WhatsApp QR</h1><img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQr)}" /><p>Refreshing every 2 minutes.</p><p>Status: <b>${clientStatus}</b></p></div><script>setTimeout(() => location.reload(), 120000);</script></body></html>`);
    } else {
        res.send('<h1>Engine Starting...</h1><p>Wait 30s and refresh.</p>');
    }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Port ${port} open.`));

// --- 2. CHROMIUM LOCK FIX ---
// Specifically targets the location where LocalAuth stores session locks
const lockPath = path.join(process.cwd(), '.wwebjs_auth', 'session', 'Default', 'SingletonLock');
if (fs.existsSync(lockPath)) { 
    try { 
        fs.unlinkSync(lockPath); 
        console.log("🔓 Unlocked existing session.");
    } catch (e) {
        console.log("⚠️ SingletonLock handled.");
    } 
}

// --- 3. INITIALIZATION ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Render-Specific Chrome Path Detection
const getChromePath = () => {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    if (fs.existsSync('/usr/bin/chromium')) return '/usr/bin/chromium';
    if (fs.existsSync('/usr/bin/google-chrome')) return '/usr/bin/google-chrome';
    return undefined; // Local fallback
};

const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'remote',
        // Direct GitHub link avoids 'webversion' timeout errors on Render
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true,
        executablePath: getChromePath(),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-first-run',
            '--js-flags=--max-old-space-size=256'
        ],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
});

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

// --- 4. BUSINESS LOGIC ---
const globalMsgLock = new Set();

async function orchestrate(msg, isOutreach) {
    const bootTime = Math.floor(Date.now() / 1000);
    if (msg.timestamp < bootTime - 60 || msg.from.includes('status') || msg.from.endsWith('@g.us')) return;

    const phone = isOutreach ? msg.to : msg.from;
    const lockKey = `${msg.id.id}`; 
    if (globalMsgLock.has(lockKey)) return;
    globalMsgLock.add(lockKey);

    try {
        let { data: lead } = await supabase.from('leads').select('*').eq('phone', phone).maybeSingle();
        if (!lead && !isOutreach) { globalMsgLock.delete(lockKey); return; }
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
            if (!lead.status || lead.status === 'Outreach Sent') nextStatus = 'Outreach Sent';
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
    } catch (e) { 
        console.error("❌ Engine Fault", e.message); 
    }
    setTimeout(() => globalMsgLock.delete(lockKey), 10000);
}

client.on('message', async (m) => { if (!m.fromMe) await orchestrate(m, false); });
client.on('message_create', async (m) => { if (m.fromMe) await orchestrate(m, true); });

client.initialize();