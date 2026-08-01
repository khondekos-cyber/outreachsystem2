module.exports = {
    calculateNextStatus: (intent, currentStatus) => {
        // Business Rules for Kanban Movement
        const rules = {
            'BOOKING': 'Interested / Demo',
            'BOOKING_CONFIRMED': 'Booked / Won',
            'QUESTION': 'AI Qualifying',
            'OBJECTION': 'AI Qualifying',
            'GREETING': 'Replied',
            'OUTREACH': 'Outreach Sent',
            'NEGATIVE': 'Lost / Ghosted'
        };

        // Rule: Only move if the new status is "higher" in the funnel than current
        // Order: Outreach Sent (0) -> Replied (1) -> AI Qualifying (2) -> Interested (3)
        const order = ["Outreach Sent", "Replied", "AI Qualifying", "Interested / Demo", "Booked / Won"];

        // Normalize whatever the AI sent us so casing/whitespace can't cause a silent miss
        const normalizedIntent = String(intent || '').trim().toUpperCase();

        // If intent is negative, ignore order and move to lost
        if (normalizedIntent === 'NEGATIVE') return 'Lost / Ghosted';

        const nextStatus = rules[normalizedIntent] || currentStatus;

        if (!rules[normalizedIntent]) {
            // This log is the whole point of this fix: if the AI ever returns an
            // intent string that isn't one of the 6 keys above, you will now SEE it
            // instead of the card just silently staying put.
            console.warn(`⚠️ pipelineService: unrecognized intent "${intent}" — status unchanged (currently "${currentStatus}")`);
        }

        const currentIndex = order.indexOf(currentStatus);
        const nextIndex = order.indexOf(nextStatus);

        // Only move forward, never backward
        return (nextIndex > currentIndex) ? nextStatus : currentStatus;
    }
};