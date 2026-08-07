const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;
let latestQr = "";
let clientStatus = "Initializing...";

app.get('/', (req, res) => {
    if (clientStatus === "READY") {
        res.send('<h1>✅ WhatsApp Connected</h1>');
    } else if (latestQr) {
        res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#f8fafc;font-family:sans-serif;"><div style="background:white;padding:40px;border-radius:30px;box-shadow:0 10px 25px rgba(0,0,0,0.05);text-align:center;"><h1>Scan WhatsApp QR</h1><img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQr)}" /><p>Status: <b>${clientStatus}</b></p></div><script>setTimeout(() => location.reload(), 30000);</script></body></html>`);
    } else {
        res.send('<h1>Starting... wait 30s and refresh.</h1>');
    }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Port ${port} open.`));

// Render-specific Chrome path detection, with built-in debug logging so we
// can see exactly what it finds (or doesn't) in the deploy logs.
const getChromePath = () => {
    const cacheRoot = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    const chromeDir = path.join(cacheRoot, 'chrome');
    console.log('🔍 Looking for Chrome in:', chromeDir);
    console.log('🔍 cacheRoot exists:', fs.existsSync(cacheRoot));
    if (fs.existsSync(cacheRoot)) {
        console.log('🔍 cacheRoot contents:', fs.readdirSync(cacheRoot));
    }
    console.log('🔍 chromeDir exists:', fs.existsSync(chromeDir));
    if (fs.existsSync(chromeDir)) {
        const versions = fs.readdirSync(chromeDir);
        console.log('🔍 chrome versions found:', versions);
        for (const version of versions) {
            const candidate = path.join(chromeDir, version, 'chrome-linux64', 'chrome');
            console.log('🔍 checking:', candidate, fs.existsSync(candidate));
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    if (fs.existsSync('/usr/bin/google-chrome')) return '/usr/bin/google-chrome';
    console.log('🔍 No Chrome found anywhere — returning undefined');
    return undefined;
};

const client = new Client({
    authStrategy: new LocalAuth(),
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
            '--mute-audio',
            '--no-first-run',
            '--js-flags=--max-old-space-size=128'
        ]
    }
});

client.on('qr', (qr) => {
    latestQr = qr;
    clientStatus = "Awaiting Scan";
    console.log('QR generated — open the app URL in a browser to scan it.');
});

client.on('ready', () => {
    latestQr = "";
    clientStatus = "READY";
    console.log('✅ WhatsApp client is ready.');
});

client.on('message', (msg) => {
    console.log(`Message from ${msg.from}: ${msg.body}`);
});

client.initialize();