module.exports = {
    COLS: [
        "Outreach Sent",
        "Follow-Up Due",
        "Follow-Up Sent",
        "Replied",
        "AI Qualifying",
        "Interested / Demo",
        "Booked / Won",
        "Lost / Ghosted"
    ],

    calculateNextStatus: (intent, currentStatus) => {
        const rules = {
            'OUTREACH': 'Outreach Sent',
            'FOLLOWUP_DRAFTED': 'Follow-Up Due',
            'AUTO_REPLY_DETECTED': 'Replied',
            'GREETING': 'Replied',
            'QUESTION': 'AI Qualifying',
            'OBJECTION': 'AI Qualifying',
            'INTERESTED': 'Interested / Demo',
            'BOOKING_CONFIRMED': 'Booked / Won',
            'NEGATIVE': 'Lost / Ghosted',
            'DECLINED': 'Lost / Ghosted'
        };

        const normalizedIntent = String(intent || '').trim().toUpperCase();

        if (normalizedIntent === 'NEGATIVE' || normalizedIntent === 'DECLINED') {
            return 'Lost / Ghosted';
        }

        if (currentStatus === 'Lost / Ghosted' || currentStatus === 'Lost / Declined') {
            return 'Lost / Ghosted';
        }

        const nextStatus = rules[normalizedIntent] || currentStatus;
        const order = [
            "Outreach Sent",
            "Follow-Up Due",
            "Follow-Up Sent",
            "Replied",
            "AI Qualifying",
            "Interested / Demo",
            "Booked / Won"
        ];

        const currentIndex = order.indexOf(currentStatus);
        const nextIndex = order.indexOf(nextStatus);

        // If lead was in Follow-Up Due or Follow-Up Sent and replies -> moves to Replied / Qualifying
        if (currentStatus === 'Follow-Up Due' || currentStatus === 'Follow-Up Sent') {
            return (nextStatus === 'Replied' || nextStatus === 'AI Qualifying') ? nextStatus : currentStatus;
        }

        return (nextIndex >= currentIndex) ? nextStatus : currentStatus;
    }
};
