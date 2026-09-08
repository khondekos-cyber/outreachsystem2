const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

module.exports = {
    // Generate intelligent, context-aware follow-up drafts based on what you actually sent
    async generateFollowUp(lead, history = [], stage = '48H_NUDGE', knowledge) {
        const leadStatus = lead.status || 'Outreach Sent';
        const lastMyMessage = (history || []).filter(m => m.from_me).pop()?.body || "";

        const prompt = `
You are Alex, an elite South African B2B sales setter writing a natural WhatsApp follow-up.
LEAD INFO:
- Name: ${lead.name || "there"}
- Industry: ${lead.industry || "Home Services"}
- Location: ${lead.location || "South Africa"}
- Stalled Pipeline Stage: "${leadStatus}"
- Follow-Up Step: ${stage} (48H_NUDGE, 7D_ASSET, or 14D_BREAKUP)
- What I sent previously: "${lastMyMessage}"

CRITICAL RULES:
- DO NOT say "did you see our quote" or "look at the quote". WE DID NOT SEND A PRICE QUOTE. We are offering an automation system that handles THEIR customer quotes.
- Maximum 1-2 short sentences. Max 1 emoji. Write like a real South African founder.

STAGE ANGLES:
1. If 48H_NUDGE:
   - Friendly bump. Assume they were busy on site or with clients.
   - Example: "Hey ${lead.name || ""}! Just bumping this in case you were busy on site — curious if your team is currently handling all those WhatsApp enquiries manually?"

2. If 7D_ASSET:
   - Offer proof/video. 
   - Example: "Hey ${lead.name || ""}, put together a quick 60-second video of how another ${lead.industry || "trade"} team automated their WhatsApp quote bookings. Mind if I drop the link here?"

3. If 14D_BREAKUP:
   - Clean closure / loss-aversion.
   - Example: "Hey ${lead.name || ""}, I'll assume automating your quote responses isn't a priority right now and I'll leave you to it! Feel free to reach out anytime if things change."

Return ONLY valid JSON:
{
  "draft": "string",
  "angle": "${stage}"
}
`;
        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "system", content: prompt }],
                response_format: { type: "json_object" },
                temperature: 0.3
            });
            return JSON.parse(completion.choices[0].message.content);
        } catch (e) {
            console.error("❌ Follow-up generator error:", e.message);
            return { draft: `Hey ${lead.name || ""}! Just bumping this in case you were busy — curious how your team handles after-hours WhatsApp quotes?`, angle: stage };
        }
    },

    // Inbound conversation decision brain
    async run(lead = {}, history = [], messageText, knowledge, isOutreach = false) {
        const now = new Date();
        const todayLabel = now.toLocaleDateString('en-ZA', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric',
            timeZone: 'Africa/Johannesburg'
        });

        // Check if demo already happened in the past
        let isPastDemo = false;
        if (lead.memory?.meeting_time) {
            const meetingDate = new Date(lead.memory.meeting_time);
            if (!isNaN(meetingDate.getTime()) && meetingDate < now) {
                isPastDemo = true;
            }
        }

        const systemPrompt = `
You are Alex, an elite South African WhatsApp sales setter for an automation agency.
TODAY IS: ${todayLabel} (SAST / UTC+2).

KNOWLEDGE BASE:
${JSON.stringify(knowledge, null, 2)}

${isOutreach ? `
=== OUTREACH INGESTION MODE ===
1. Verify if this message is a personalized cold pitch.
2. Extract: Lead name, Industry, Location, Social stats.
3. Set intent="OUTREACH".
` : `
=== INBOUND SETTER MODE ===
LEAD CONTEXT:
- Name: ${lead.name || "Unknown"}
- Industry: ${lead.industry || "Home Services"}
- Location: ${lead.location || "South Africa"}
- Current Status: ${lead.status || "Replied"}
- Memory Facts: ${JSON.stringify(lead.memory || {})}
- Past Demo Completed: ${isPastDemo ? "YES (Demo already took place in the past. DO NOT re-book or talk about past demo times.)" : "NO"}

CRITICAL RULES (ANTI-HALLUCINATION):
1. CASUAL BANTER & CATCH-UPS:
   - If the lead sends casual messages like "hope you are well bro", "how are things", "how's business":
   - DO NOT set intent="BOOKING_CONFIRMED".
   - DO NOT say "Looking forward to our demo on Tuesday".
   - Set intent="GREETING".
   - Reply warmly in 1 short sentence: "Doing great bro, thanks for asking! How are things on your side?"

2. PAST DEMOS:
   - If Past Demo Completed is YES, this person is an existing relationship. Never propose old demo times.

3. AUTO-RESPONDERS:
   - If lead message is an automated greeting / office hours / price menu:
   - Set intent="AUTO_REPLY_DETECTED".
   - Reply: "Hey! Thanks for getting back. Just had a quick question regarding how you handle WhatsApp enquiries when your team is busy on jobs?"

4. NEW BOOKINGS:
   - ONLY set intent="BOOKING_CONFIRMED" if the lead explicitly agreed to a specific upcoming date/time in THIS message.
   - Resolve to ISO-8601 string in Africa/Johannesburg timezone.

5. HARD DECLINES:
   - If lead says "No thanks", "Stop", "Not interested":
   - Set intent="DECLINED", lead_score=0.
`}

RESPONSE JSON SCHEMA:
{
  "reply": "string",
  "intent": "OUTREACH" | "AUTO_REPLY_DETECTED" | "GREETING" | "QUESTION" | "OBJECTION" | "INTERESTED" | "BOOKING_CONFIRMED" | "DECLINED",
  "meeting_datetime_iso": "string or null",
  "extracted_identity": {
    "name": "string or null",
    "industry": "string or null",
    "location": "string or null",
    "stats": "string or null"
  },
  "new_facts": {
    "current_crm": "string or null",
    "budget": "string or null",
    "meeting_time": "string or null",
    "employees": "string or null",
    "lead_volume": "string or null",
    "sales_process": "string or null"
  },
  "lead_score": 0-100,
  "pain_points": "string"
}`;

        try {
            const formattedHistory = (history || []).map(m => ({
                role: m.from_me ? "assistant" : "user",
                content: m.body || ""
            }));

            const messages = [
                { role: "system", content: systemPrompt },
                ...formattedHistory,
                { role: "user", content: messageText }
            ];

            const completion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                response_format: { type: "json_object" },
                temperature: 0.2
            });

            return JSON.parse(completion.choices[0].message.content);
        } catch (e) {
            console.error("❌ Decision service error:", e.message);
            return {
                reply: "Hey! Thanks for getting back. How are things on your side?",
                intent: "GREETING",
                meeting_datetime_iso: null,
                extracted_identity: {},
                new_facts: {},
                lead_score: lead?.lead_score || 50,
                pain_points: lead?.pain_points || ""
            };
        }
    }
};
