module.exports = {
    calculateNextStatus: (intent, currentStatus) => {
        const rules = {
            'BOOKING': 'Interested / Demo',
            'BOOKING_CONFIRMED': 'Booked / Won',
            'QUESTION': 'AI Qualifying',
            'OBJECTION': 'AI Qualifying',
            'GREETING': 'Replied',
            'OUTREACH': 'Outreach Sent',
            'NEGATIVE': 'Lost / Ghosted'
        };

        const order = ["Outreach Sent", "Replied", "AI Qualifying", "Interested / Demo", "Booked / Won"];
        const normalizedIntent = String(intent || '').trim().toUpperCase();

        if (normalizedIntent === 'NEGATIVE') return 'Lost / Ghosted';

        const nextStatus = rules[normalizedIntent] || currentStatus;

        if (!rules[normalizedIntent]) {
            console.warn(`⚠️ pipelineService: unrecognized intent "${intent}" — keeping "${currentStatus}"`);
        }

        const currentIndex = order.indexOf(currentStatus);
        const nextIndex = order.indexOf(nextStatus);

        // Forward progression only
        return (nextIndex > currentIndex) ? nextStatus : currentStatus;
    }
};
