const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

module.exports = {
    async run(lead, history, incomingMessage, knowledge, isOutreach = false) {
        const now = new Date();
        const todayLabel = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const needsProcessDiscovery = !isOutreach && lead.memory?.video_sent === true && !lead.sales_process;

        const prompt = `
        You are an elite Sales Analyst. Extract FACTS for a CRM SSOT.

        CONTEXT: ${isOutreach ? "ANALYZING MY OUTREACH MESSAGE." : "ANALYZING LEAD REPLY."}
        TODAY IS: ${todayLabel} (assume CAT / UTC+2 timezone unless the lead states otherwise). Use this to resolve relative dates like "Monday" or "tomorrow at 3" into an absolute date.
        ${needsProcessDiscovery ? `SPECIAL INSTRUCTION: The demo is already booked and success-story videos already sent. Your reply must warmly ask what their current WhatsApp/Facebook sales process or script looks like today, before the demo — e.g. "Quick one before we hop on the call — what does your current process for replying to WhatsApp enquiries look like right now?" Keep it natural, 1-2 sentences.` : ''}

        PRODUCT KNOWLEDGE (this is what WE sell — use it to answer questions accurately and shape the reply):
        ${JSON.stringify(knowledge, null, 2)}

        LEAD CONTEXT SO FAR:
        - Known name: ${lead.name || "unknown"}
        - Known industry: ${lead.industry || "unknown"}
        - Known location: ${lead.location || "unknown"}
        - Existing memory/facts: ${JSON.stringify(lead.memory || {})}
        - Current conversation state: ${JSON.stringify(lead.conv_state || {})}

        TASK:
        1. EXTRACT IDENTITY:
           - Business Name (e.g. Africa On Solar)
           - Niche (e.g. Boreholes, Solar, Dentist)
           - Location (e.g. Zimbabwe)
           - Stats (e.g. 10k followers)
        2. MINE FACTS: Update memory with current CRM used, lead volume, budget, meeting time (raw text, e.g. "Monday at 3 PM"), employees.
           For each field: return the value as a string if mentioned/known, or null if not yet known. Never invent a value.
        2b. SALES PROCESS: If the lead describes how they currently handle WhatsApp/Facebook enquiries or their sales script (e.g. "we just reply manually", "no real process", "I follow a script but it's not automated"), capture it in sales_process as a short 1-sentence paraphrase. Otherwise null. Never invent one.
        3. INTENT: pick exactly one of OUTREACH, GREETING, QUESTION, OBJECTION, BOOKING, BOOKING_CONFIRMED, NEGATIVE.
           - BOOKING: the lead wants a demo/call but has NOT yet given a specific date/time.
           - BOOKING_CONFIRMED: the lead has just given (or clearly agreed to) a specific date/time for the demo, e.g. "Monday at 3", "tomorrow at 10am works".
        3b. MEETING DATETIME: If intent is BOOKING_CONFIRMED, resolve the mentioned date/time into an absolute ISO 8601 datetime (e.g. "2026-08-03T15:00:00+02:00") using TODAY'S DATE above, and return it in meeting_datetime_iso. Otherwise return null.
        4. REPLY: ${isOutreach ? "NONE" : "1-2 enthusiastic sentences with 1 emoji 🚀. If the lead asks a factual question (e.g. 'what is a CRM'), answer it using the PRODUCT KNOWLEDGE above before pivoting back to booking a demo."}
        5. LEAD SCORE: Score this lead's buying intent from 0-100 based on the WHOLE conversation so far, using this rubric:
           - 0-20: Cold outreach, no reply yet, or a flat "no"/"not interested" (NEGATIVE intent).
           - 21-40: Replied but noncommittal (e.g. "ok", "who is this", single-word replies with no engagement).
           - 41-60: Asking genuine questions about the product, pricing, or how it works (engaged, still evaluating).
           - 61-80: Raised a specific objection or need ("I need assistance with X", asked about their specific business use case) — this signals real pain, not just curiosity.
           - 81-100: Explicitly agreed to a demo/call, gave a concrete time, or said something equivalent to "yes let's do this."
           Weight the MOST RECENT message and INTENT most heavily, but don't ignore earlier context.
        6. PAIN POINTS: In 1 short sentence, summarize the specific business problem this lead has expressed (e.g. "Misses WhatsApp enquiries during busy hours and has no way to track leads"). If nothing specific has been expressed yet, return an empty string — do not invent one.

        STRICT RULES:
        - If I say "I followed [X] page", X is the Business Name.
        - Always ground factual answers in PRODUCT KNOWLEDGE. Do not invent pricing, features, or integrations that aren't listed there.
        - intent MUST be exactly one of: OUTREACH, GREETING, QUESTION, OBJECTION, BOOKING, BOOKING_CONFIRMED, NEGATIVE. No other spellings, no suffixes, no lowercase.
        - lead_score must be a number 0-100, not a string.
        - pain_points must be grounded in what the lead actually said — no invented details.
        - JSON ONLY. No invented details.`;

        // Gemini's schema syntax differs from OpenAI's: types are UPPERCASE strings,
        // and instead of `type: ["string", "null"]` it uses `nullable: true`.
        // This is what fixes the pipeline-not-moving bug in the first place — intent
        // is still hard-constrained to an enum, just in Gemini's format now.
        const schema = {
            type: "OBJECT",
            properties: {
                reply: { type: "STRING" },
                intent: {
                    type: "STRING",
                    enum: ["OUTREACH", "GREETING", "QUESTION", "OBJECTION", "BOOKING", "BOOKING_CONFIRMED", "NEGATIVE"]
                },
                meeting_datetime_iso: { type: "STRING", nullable: true },
                extracted_identity: {
                    type: "OBJECT",
                    properties: {
                        name: { type: "STRING" },
                        industry: { type: "STRING" },
                        location: { type: "STRING" },
                        stats: { type: "STRING" }
                    },
                    required: ["name", "industry", "location", "stats"]
                },
                new_facts: {
                    type: "OBJECT",
                    properties: {
                        current_crm: { type: "STRING", nullable: true },
                        budget: { type: "STRING", nullable: true },
                        meeting_time: { type: "STRING", nullable: true },
                        employees: { type: "STRING", nullable: true },
                        lead_volume: { type: "STRING", nullable: true },
                        sales_process: { type: "STRING", nullable: true }
                    },
                    required: ["current_crm", "budget", "meeting_time", "employees", "lead_volume", "sales_process"]
                },
                updated_state: {
                    type: "OBJECT",
                    properties: {
                        stage: { type: "STRING" },
                        goal: { type: "STRING" }
                    },
                    required: ["stage", "goal"]
                },
                lead_score: { type: "NUMBER" },
                pain_points: { type: "STRING" }
            },
            required: ["reply", "intent", "meeting_datetime_iso", "extracted_identity", "new_facts", "updated_state", "lead_score", "pain_points"]
        };

        try {
            // Gemini uses "model" instead of "assistant" for the bot's own turns,
            // and takes the system prompt separately via config.systemInstruction
            // rather than as a message in the array.
            const contents = [
                ...history.map(m => ({ role: m.from_me ? "model" : "user", parts: [{ text: m.body }] })),
                { role: "user", parts: [{ text: incomingMessage }] }
            ];

            const response = await ai.models.generateContent({
                model: "gemini-flash-lite-latest", // Flash-Lite tier: far higher free daily quota than flagship Flash (which caps at ~20/day)
                contents,
                config: {
                    systemInstruction: prompt,
                    responseMimeType: "application/json",
                    responseSchema: schema
                }
            });

            return JSON.parse(response.text);
        } catch (e) {
            console.error("❌ DECISION SERVICE ERROR:", e.message);
            return { reply: "None", intent: "ERROR", meeting_datetime_iso: null, extracted_identity: {}, new_facts: {}, updated_state: lead.conv_state || {}, lead_score: lead.lead_score || 0, pain_points: lead.pain_points || "" };
        }
    }
};