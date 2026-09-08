require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

// Modular Services
const decisionService = require('./services/decisionService');
const knowledgeService = require('./services/knowledgeService');
const pipelineService = require('./services/pipelineService');
const eventService = require('./services/eventService');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let sock;
let currentQrBase64 = null;
let isConnected = false;

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="font-family:sans-serif; text-align:center; margin-top:50px; color:green;">✅ WhatsApp is connected!</h2>');
    }
    if (!currentQrBase64) {
        return res.send('<h2 style="font-family:sans-serif; text-align:center; margin-top:50px;">⏳ Generating QR code, refreshing in 3s...</h2><script>setTimeout(() => location.reload(), 3000);</script>');
    }
    res.send(`
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:90vh; font-family:sans-serif;">
            <h2>Scan WhatsApp QR Code</h2>
            <img src="${currentQrBase64}" alt="QR Code" style="border: 4px solid #333; border-radius: 12px; width: 300px; height: 300px;" />
        </div>
    `);
});

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
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
            console.log(`Connection closed (status ${statusCode}), reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            isConnected = true;
            currentQrBase64 = null;
            console.log('✅ Baileys WhatsApp client is connected and listening');
            io.emit('ready');
        }
    });

    // Message Orchestrator
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) {
                continue;
            }

            const cleanPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '');
            const body = msg.message.conversation ||
                         msg.message.extendedTextMessage?.text ||
                         msg.message.imageMessage?.caption || '';

            if (!body.trim()) continue;

            const isOutbound = msg.key.fromMe;
            const knowledge = knowledgeService.getKnowledge();

            // ========================================================
            // FLOW 1: OUTBOUND OUTREACH INGESTION (fromMe === true)
            // ========================================================
            if (isOutbound) {
                console.log(`\n📤 Analyzing Outbound message to ${cleanPhone}: "${body}"`);

                const decision = await decisionService.run({}, [], body, knowledge, true);

                if (decision.intent !== 'OUTREACH') {
                    console.log(`⏭️ [SKIPPED] Casual outbound message without business context.`);
                    continue;
                }

                let { data: lead } = await supabase
                    .from('leads')
                    .select('*')
                    .or(`phone.eq.${remoteJid},phone.eq.${cleanPhone}`)
                    .maybeSingle();

                if (!lead) {
                    const { data: newLead, error } = await supabase
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
                            lead_score: 10
                        })
                        .select()
                        .single();

                    if (error) {
                        console.error('❌ Supabase insert error:', error.message);
                        continue;
                    }
                    lead = newLead;
                    console.log(`✅ [INGESTED LEAD] ${lead.name} locked into SSOT.`);
                }

                await supabase.from('messages').insert({
                    lead_id: lead.id,
                    body: body,
                    from_me: true
                });

                await eventService.log(
                    lead.id,
                    'OUTREACH',
                    `Outreach sent to ${lead.name}`,
                    { identity: decision.extracted_identity }
                );

                io.emit('lead_updated', { lead_id: lead.id, status: 'Outreach Sent' });
                continue;
            }

            // ========================================================
            // FLOW 2: INBOUND LEAD REPLY (fromMe === false)
            // ========================================================
            try {
                const { data: lead, error: leadError } = await supabase
                    .from('leads')
                    .select('*')
                    .or(`phone.eq.${remoteJid},phone.eq.${cleanPhone}`)
                    .maybeSingle();

                if (leadError) {
                    console.error('❌ Supabase lookup error:', leadError.message);
                    continue;
                }

                if (!lead) {
                    console.log(`⏭️ [IGNORED] Inbound from ${remoteJid}: Not a registered lead.`);
                    continue;
                }

                console.log(`\n📩 Inbound lead reply from ${lead.name || lead.phone}: "${body}"`);

                // 1. Fetch Conversation History
                const { data: history } = await supabase
                    .from('messages')
                    .select('body, from_me, created_at')
                    .eq('lead_id', lead.id)
                    .order('created_at', { ascending: true })
                    .limit(20);

                // 2. Save Inbound Message
                await supabase.from('messages').insert({
                    lead_id: lead.id,
                    body: body,
                    from_me: false
                });

                // 3. Trigger Decision Brain (GPT-4o)
                const decision = await decisionService.run(lead, history || [], body, knowledge, false);
                console.log('🧠 AI Decision:', JSON.stringify(decision, null, 2));

                // 4. Calculate Stage Movement
                const nextStatus = pipelineService.calculateNextStatus(decision.intent, lead.status || 'Replied');

                // 5. Parse & Merge SSOT Memory Facts
                let memoryObj = {};
                if (typeof lead.memory === 'string') {
                    try { memoryObj = JSON.parse(lead.memory); } catch (e) { memoryObj = {}; }
                } else if (typeof lead.memory === 'object' && lead.memory !== null) {
                    memoryObj = { ...lead.memory };
                }

                if (decision.new_facts) {
                    Object.entries(decision.new_facts).forEach(([k, v]) => {
                        if (v !== null && v !== undefined && v !== '') {
                            memoryObj[k] = v;
                        }
                    });
                }
                if (decision.meeting_datetime_iso) {
                    memoryObj.meeting_time = decision.meeting_datetime_iso;
                }

                // 6. Update Lead in SSOT
                await supabase.from('leads').update({
                    name: decision.extracted_identity?.name || lead.name,
                    industry: decision.extracted_identity?.industry || lead.industry,
                    location: decision.extracted_identity?.location || lead.location,
                    status: nextStatus,
                    memory: memoryObj,
                    conv_state: decision.updated_state || lead.conv_state,
                    lead_score: decision.lead_score ?? lead.lead_score,
                    pain_points: decision.pain_points || lead.pain_points,
                    sales_process: decision.new_facts?.sales_process || lead.sales_process,
                    last_message_at: new Date().toISOString()
                }).eq('id', lead.id);

                // 7. Insert into `bookings` using `scheduled_at`
                if (decision.intent === 'BOOKING_CONFIRMED' && decision.meeting_datetime_iso) {
                    const { error: bookingErr } = await supabase.from('bookings').insert({
                        lead_id: lead.id,
                        scheduled_at: decision.meeting_datetime_iso,
                        status: 'confirmed'
                    });

                    if (bookingErr) {
                        console.error('❌ Error inserting into bookings table:', bookingErr.message);
                    } else {
                        console.log(`📅 [BOOKINGS TABLE UPDATED] scheduled_at: ${decision.meeting_datetime_iso}`);
                    }
                }

                // 8. Audit Trail Log
                await eventService.log(
                    lead.id,
                    decision.intent,
                    `Moved [${lead.status}] ➔ [${nextStatus}] (Score: ${decision.lead_score})`,
                    { intent: decision.intent, facts: decision.new_facts, scheduled_at: decision.meeting_datetime_iso }
                );

                // 9. Send WhatsApp Reply
                if (decision.reply && decision.reply !== "None" && decision.reply.trim() !== "") {
                    await sock.sendMessage(remoteJid, { text: decision.reply });

                    await supabase.from('messages').insert({
                        lead_id: lead.id,
                        body: decision.reply,
                        from_me: true
                    });

                    console.log(`📤 Sent reply to ${lead.name}: "${decision.reply}"`);
                }

                // 10. Emit Realtime Update
                io.emit('lead_updated', {
                    lead_id: lead.id,
                    status: nextStatus,
                    lead_score: decision.lead_score
                });

            } catch (err) {
                console.error('❌ Error handling message pipeline:', err);
            }
        }
    });
}

io.on('connection', (socket) => {
    socket.emit('status', 'Connected to Fact-Bank backend');
    if (currentQrBase64) socket.emit('qr', currentQrBase64);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Fact-Bank Server running on port ${PORT}`);
    startWhatsApp();
});
