const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

module.exports = {
    // Generate 48h / 7d / 14d Follow-Up Drafts with the EXACT niche demo
    async generateFollowUp(lead, history = [], stage = '48H_NUDGE', knowledge) {
        const leadStatus = lead.status || 'Outreach Sent';
        const isLaundromat = (lead.industry || "").toLowerCase().includes("laundry") || (lead.name || "").toLowerCase().includes("laundromat");
        const demoLink = isLaundromat ? knowledge.demos.laundromat.url : knowledge.demos.dog_food.url;
        const demoName = isLaundromat ? knowledge.demos.laundromat.name : knowledge.demos.dog_food.name;

        const prompt = `
You are Alex, an expert South African B2B setter following up on a web app demo pitch.
LEAD INFO:
- Business: ${lead.name || "there"}
- Industry: ${isLaundromat ? "Laundromat / Dry Cleaning" : "Dog Food Supplier"}
- Relevant Demo: ${demoName} (${demoLink})
- Step: ${stage} (48H_NUDGE, 7D_ASSET, or 14D_BREAKUP)

ANGLES:
1. 48H_NUDGE:
   ${isLaundromat 
     ? '"Hey ' + (lead.name || '') + '! No pressure at all — just thought an automated booking portal might save your team answering repetitive collection calls during busy days. Here is the Kusile Laundry demo if you want to test it: ' + demoLink + '"'
     : '"Hey ' + (lead.name || '') + '! No pressure at all — just thought it might save you a few hours of manual WhatsApp order-taking a week. Here is the Klerksdorp Hondekos demo if you want to take a quick look: ' + demoLink + '"'
   }

2. 7D_ASSET:
   - "Hey ${lead.name || ""}, put together a quick 60-second walkthrough of how ${demoName} automated their orders online. Mind if I send it over?"

3. 14D_BREAKUP:
   - "Hey ${lead.name || ""}, I'll assume an online booking portal isn't a priority for your setup right now and I won't bug you again! Feel free to reach out anytime if things change."

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
            return { 
                draft: `Hey ${lead.name || ""}! No pressure — just thought an online portal might save your team time taking manual orders. Here is the ${demoName} demo: ${demoLink}`, 
                angle: stage 
            };
        }
    },

    // Inbound Setter Brain with Niche-Specific Demo Injection
    async run(lead = {}, history = [], messageText, knowledge, isOutreach = false) {
        const now = new Date();
        const todayLabel = now.toLocaleDateString('en-ZA', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric',
            timeZone: 'Africa/Johannesburg'
        });

        const isLaundromat = (lead.industry || "").toLowerCase().includes("laundry") || (lead.name || "").toLowerCase().includes("laundromat");
        const activeDemo = isLaundromat ? knowledge.demos.laundromat : knowledge.demos.dog_food;

        const systemPrompt = `
You are Alex, an elite South African web developer and setter turning static local businesses into functional online ordering/booking web apps.
TODAY IS: ${todayLabel} (SAST / UTC+2).

NICHE DEMO LOADED FOR THIS LEAD:
- Demo Name: ${activeDemo.name}
- Demo URL: ${activeDemo.url}
- What it does: ${activeDemo.description}

${isOutreach ? `
=== OUTREACH INGESTION MODE ===
1. Verify if this outbound message is pitching an online store / booking web app for Dog Food or Laundromats.
2. Extract: Lead name, Industry (Dog Food Supplier or Laundromat), Location, Social stats.
3. Set intent="OUTREACH".
` : `
=== INBOUND SETTER MODE ===
LEAD CONTEXT:
- Name: ${lead.name || "Unknown"}
- Industry: ${isLaundromat ? "Laundromat / Dry Cleaning" : "Dog Food / Pet Nutrition"}
- Location: ${lead.location || "South Africa"}
- Current Status: ${lead.status || "Replied"}

SETTER PROTOCOL:
1. IF LEAD SAYS "YES / SEND IT / INTERESTED":
   - Send the exact demo URL: "${activeDemo.url}"
   - Reply naturally: "Here's the live ${activeDemo.name} setup: ${activeDemo.url} — you can test selecting services and scheduling a pickup. Would you have 10 minutes tomorrow at 10:00 AM or 2:00 PM to see how this would look for your brand?"
   - Set intent="INTERESTED".

2. LAUNDROMAT LEAD (Pain discovery):
   - If they say they currently take bookings on WhatsApp / phone:
   - Validate them $\rightarrow$ Point out that customers love scheduling doorstep collections in under 60 seconds $\rightarrow$ Offer the Kusile demo.
   - Set intent="QUESTION".

3. DOG FOOD LEAD (Order discovery):
   - If they take orders manually on WhatsApp:
   - Share how Klerksdorp Hondekos automated bag selection & upfront payments $\rightarrow$ Offer the Hondekos demo.
   - Set intent="QUESTION".

4. TIME AGREED:
   - If they agree to a walkthrough time:
   - Set intent="BOOKING_CONFIRMED" $\rightarrow$ Resolve datetime to ISO-8601 string.

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
                reply: `Hey! Thanks for getting back. Here is the live demo setup: ${activeDemo.url} — let me know what you think!`,
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
