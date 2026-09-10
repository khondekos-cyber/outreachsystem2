const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

module.exports = {
    // Generate 48h / 7d / 14d Follow-Up Drafts tailored to Dog Food & Laundromats
    async generateFollowUp(lead, history = [], stage = '48H_NUDGE', knowledge) {
        const leadStatus = lead.status || 'Outreach Sent';
        const isLaundromat = (lead.industry || "").toLowerCase().includes("laundry") || (lead.name || "").toLowerCase().includes("laundromat");

        const prompt = `
You are Alex, an expert South African B2B setter following up on an outreach message about building functional web apps / online ordering portals.
LEAD CONTEXT:
- Business: ${lead.name || "there"}
- Industry: ${lead.industry || (isLaundromat ? "Laundromat" : "Dog Food Supplier")}
- Current Status: "${leadStatus}"
- Follow-Up Step: ${stage} (48H_NUDGE, 7D_ASSET, or 14D_BREAKUP)
- Demo Link: ${knowledge.demo_asset_url}

ANGLES:
1. 48H_NUDGE (Soft bump + value):
   ${isLaundromat 
     ? '"Hey ' + (lead.name || '') + '! No pressure at all — just thought an automated booking portal might save you a few missed laundry collection calls during busy days. Mind if I drop a quick 60-sec demo?"'
     : '"Hey ' + (lead.name || '') + '! No pressure at all — just thought it might save you a few hours of manual WhatsApp order-taking a week. Here is the Klerksdorp Hondekos demo if you want to take a quick look: ' + knowledge.demo_asset_url + '"'
   }

2. 7D_ASSET:
   - "Hey ${lead.name || ""}, put together a 60-second video of how a local ${isLaundromat ? "laundry" : "pet food"} business automated their orders online. Want me to send the walkthrough over?"

3. 14D_BREAKUP:
   - "Hey ${lead.name || ""}, I'll assume an online ordering portal isn't a priority for your setup right now and I won't bug you again! Feel free to reach out anytime if you want to see it in action."

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
                draft: `Hey ${lead.name || ""}! No pressure — just thought an online ordering portal might save your team time taking manual WhatsApp orders. Here is a quick demo: ${knowledge.demo_asset_url}`, 
                angle: stage 
            };
        }
    },

    // Inbound conversation decision brain (Demo-Led Framework)
    async run(lead = {}, history = [], messageText, knowledge, isOutreach = false) {
        const now = new Date();
        const todayLabel = now.toLocaleDateString('en-ZA', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric',
            timeZone: 'Africa/Johannesburg'
        });

        const isAlreadyBooked = lead.status === 'Booked / Won';

        const systemPrompt = `
You are Alex, an elite South African web developer and setter specializing in turning static businesses into functional online ordering and booking web applications.
TODAY IS: ${todayLabel} (SAST / UTC+2).

KNOWLEDGE BASE:
${JSON.stringify(knowledge, null, 2)}

${isOutreach ? `
=== OUTREACH INGESTION MODE ===
1. Verify if this outbound message is a personalized pitch for online ordering / booking web apps.
2. Extract: Lead name, Industry (Dog Food Supplier or Laundromat), Location, Social stats.
3. Set intent="OUTREACH".
` : `
=== INBOUND SETTER MODE (DEMO-LED FRAMEWORK) ===
LEAD CONTEXT:
- Name: ${lead.name || "Unknown"}
- Industry: ${lead.industry || "Dog Food / Laundromat"}
- Location: ${lead.location || "South Africa"}
- Current Status: ${lead.status || "Replied"}
- Memory: ${JSON.stringify(lead.memory || {})}
- Demo Already Held: ${isAlreadyBooked ? "YES" : "NO"}

CONVERSATIONAL PROTOCOL:
1. IF LEAD SAYS "YES / SEND IT / INTERESTED":
   - Drop the exact demo asset: "${knowledge.demo_asset_url}"
   - Ask for a quick 10-minute walkthrough call: "Here's a 60-sec look at the Klerksdorp Hondekos setup: ${knowledge.demo_asset_url} — would you have 10 minutes tomorrow around 10:00 AM or 2:00 PM to see how this would look with your brand & pricing?"
   - Set intent="INTERESTED".

2. LAUNDROMAT LEAD REPLIES (Testing the pain):
   - If they say "We take bookings on WhatsApp/Calls":
   - Reply: "Makes complete sense! We found laundry teams waste 2+ hours a day texting back and forth for pickup times and pricing. Mind if I show you how to automate that with an online booking portal?"
   - Set intent="QUESTION".

3. DOG FOOD LEAD REPLIES:
   - If they explain how they currently sell:
   - Validate them $\rightarrow$ Share how Klerksdorp Hondekos stopped chasing manual EFT proofs by taking orders on their custom web portal.
   - Set intent="QUESTION".

4. TIME OFFERED / DEMO CONFIRMED:
   - If they agree to a specific time:
   - Confirm it warmly $\rightarrow$ Set intent="BOOKING_CONFIRMED" $\rightarrow$ Resolve datetime to ISO-8601 string.

5. HARD DECLINES:
   - If lead says "Not interested", "No thanks":
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
                reply: `Hey! Thanks for getting back. Here is a quick look at the custom ordering app: ${knowledge.demo_asset_url} — let me know what you think!`,
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
