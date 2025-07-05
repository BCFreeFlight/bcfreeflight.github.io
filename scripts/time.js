/**
 * Class for handling time formatting
 */
export class Time {
    timeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);

        const timeUnits = [
            {name: 'year', seconds: 31536000},
            {name: 'month', seconds: 2592000},
            {name: 'day', seconds: 86400},
            {name: 'hour', seconds: 3600},
            {name: 'minute', seconds: 60},
            {name: 'second', seconds: 1}
        ];

        for (const unit of timeUnits) {
            const interval = Math.floor(seconds / unit.seconds);
            if (interval >= 1) {
                return interval === 1
                    ? `1 ${unit.name} ago`
                    : `${interval} ${unit.name}s ago`;
            }
        }

        return 'just now';
    }

    format(date) {
        return date.toLocaleTimeString([], {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
                timeZoneName: 'short'
            }
        );
    }
}

// Export a default instance of the Time class
const time = new Time();
export default time;
