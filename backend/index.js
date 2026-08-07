const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Persist session so you don't need to re-scan every restart
const client = new Client({ authStrategy: new LocalAuth(), puppeteer: { headless: true } });
client.initialize();

client.on('qr', qr => {
  qrcode.toDataURL(qr, (err, url) => {
    if (err) return console.error('QR -> DataURL error', err);
    io.emit('qr', url);
  });
});

client.on('ready', () => io.emit('ready'));
client.on('authenticated', () => io.emit('authenticated'));
client.on('auth_failure', e => io.emit('auth_failure', String(e)));

io.on('connection', socket => {
  socket.emit('status', 'connected to server');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));