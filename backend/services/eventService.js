const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = {
    log: async (leadId, type, desc, meta = {}) => {
        try {
            await supabase.from('events').insert({
                lead_id: leadId,
                event_type: type,
                description: desc,
                metadata: meta
            });
            console.log(`[EVENT LOG] ${type}: ${desc}`);
        } catch (err) {
            console.error('❌ Failed to write event log:', err.message);
        }
    }
};
