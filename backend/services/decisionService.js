const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

module.exports = {
    async run(lead = {}, history = [], messageText, knowledge, isOutreach = false) {
        const now = new Date();
        const todayLabel = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const needsProcessDiscovery = !isOutreach && lead.memory?.video_sent === true && !lead.sales_process;

        const systemPrompt = `
You are an elite Sales Analyst and Automated Setter engine.

MODE: ${isOutreach ? "OUTREACH INGESTION (ANALYZING MY OUTBOUND MESSAGE)" : "INBOUND LEAD REPLY (ANALYZING LEAD RESPONSE)"}
TODAY IS: ${todayLabel} (assume CAT / UTC+2 timezone unless stated otherwise).

PRODUCT KNOWLEDGE:
${JSON.stringify(knowledge, null, 2)}

${isOutreach ? `
=== OUTREACH INGESTION RULES ===
1. Check if outbound message is a genuine cold sales pitch with business context.
2. If YES: intent = "OUTREACH", extract name, industry, location, stats.
3. If NO (casual text like "hy", "see you later"): intent = "NEGATIVE", extracted_identity = null.
` : `
=== INBOUND LEAD CONTEXT ===
- Known Name: ${lead.name || "unknown"}
- Known Industry: ${lead.industry || "unknown"}
- Known Location: ${lead.location || "unknown"}
- Existing Memory/Facts: ${JSON.stringify(lead.memory || {})}
- Current State: ${JSON.stringify(lead.conv_state || {})}

=== INBOUND SETTER RULES ===
1. MINE FACTS: Extract current_crm, lead_volume, budget, employees, sales_process, and meeting_time. If lead gives a date/time (e.g. "Thursday around 12"), capture it verbatim in meeting_time.
2. INTENT: Exactly one of ["GREETING", "QUESTION", "OBJECTION", "BOOKING", "BOOKING_CONFIRMED", "NEGATIVE"].
   - BOOKING_CONFIRMED: Lead agreed to or gave a specific time.
3. MEETING DATETIME: If BOOKING_CONFIRMED, resolve to ISO-8601 string (e.g. "2026-09-03T12:00:00+02:00").
4. REPLY: 1-2 enthusiastic sentences with 1 emoji 🚀.
5. LEAD SCORE: 0-100.
6. PAIN POINTS: 1 short sentence summarizing business pain.
${needsProcessDiscovery ? `SPECIAL: Demo booked. Ask what their current WhatsApp/Facebook sales process looks like right now.` : ''}
`}

RETURN ONLY VALID JSON MATCHING THIS SCHEMA:
{
  "reply": "string",
  "intent": "OUTREACH" | "GREETING" | "QUESTION" | "OBJECTION" | "BOOKING" | "BOOKING_CONFIRMED" | "NEGATIVE",
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
  "updated_state": {
    "stage": "string",
    "goal": "string"
  },
  "lead_score": 0,
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
            console.error("❌ DECISION SERVICE ERROR:", e.message);
            return {
                reply: "",
                intent: "ERROR",
                meeting_datetime_iso: null,
                extracted_identity: {},
                new_facts: {},
                updated_state: lead?.conv_state || {},
                lead_score: lead?.lead_score || 0,
                pain_points: lead?.pain_points || ""
            };
        }
    }
};
