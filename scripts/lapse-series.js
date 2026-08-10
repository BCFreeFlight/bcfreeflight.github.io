/**
 * Lapse rate, through the day.
 *
 * Weather Underground has no such graph, because a lapse rate is not a
 * measurement any one station makes: it is the temperature difference between
 * two stations divided by the height between them. So it is assembled here,
 * from the days already read for each station.
 *
 * The pairs are the same ones the rest of the page shows — each station against
 * the next one down the hill — so a segment on the tab bar and a line on the
 * chart mean the same thing.
 */

// A reading further than this from the moment being matched is too old to
// pair with: five-minute buckets rarely line up exactly between stations, but
// a quarter of an hour apart is a different afternoon.
const ALIGN_TOLERANCE = 10 * 60 * 1000;

const COLOURS = ['#b5442f', '#0f7d8f', '#8a5a12'];

/**
 * The reading a station had at a moment, if it had one near enough.
 * @param {number[]} times - That station's reading times
 * @param {?number[]} column - The values beside them
 * @param {number} time - The moment being matched
 * @returns {?number} The value, or null when nothing lines up
 */
function at(times, column, time) {
    if (!times?.length || !column) return null;

    let best = 0;
    for (let i = 1; i < times.length; i++) {
        if (Math.abs(times[i] - time) < Math.abs(times[best] - time)) best = i;
    }

    return Math.abs(times[best] - time) > ALIGN_TOLERANCE ? null : column[best];
}

/**
 * Builds one lapse-rate series per adjacent pair of stations.
 *
 * Stations are ranked by the elevation they report, so the pairs read downhill
 * whatever order the configuration lists them in, and a station with no day
 * logged drops out and lets its neighbours pair up.
 *
 * @param {Object[]} entries - Station entries, each with its station, elevation and day
 * @returns {Object[]} Series definitions, each carrying its own column builder
 */
export function lapsePairs(entries) {
    const ranked = entries
        .filter(entry => entry.day?.values?.temp && Number.isFinite(entry.elevation))
        .sort((a, b) => b.elevation - a.elevation);

    const pairs = [];

    for (let i = 0; i < ranked.length - 1; i++) {
        const upper = ranked[i];
        const lower = ranked[i + 1];
        const gap = (upper.elevation - lower.elevation) / 1000;

        // Two stations at the same height cannot describe a lapse between them.
        if (Math.abs(gap) < 0.001) continue;

        pairs.push({
            key: `lapse_${pairs.length}`,
            label: `${upper.station.shortName} → ${lower.station.shortName}`,
            unit: 'ºC/1000 ft',
            colour: COLOURS[pairs.length % COLOURS.length],
            group: 'lapse',
            on: true,
            digits: 2,
            upper,
            lower,
            gap
        });
    }

    return pairs;
}

/**
 * Works a pair's lapse rate out across one station's own reading times, so the
 * result can be charted beside that station's other measurements.
 * @param {Object} pair - A pair from lapsePairs
 * @param {number[]} times - The times to compute against
 * @returns {?number[]} One value per time, with gaps where a station was dark
 */
export function lapseColumn(pair, times) {
    return times.map(time => {
        const warm = at(pair.lower.day.times, pair.lower.day.values.temp, time);
        const cool = at(pair.upper.day.times, pair.upper.day.values.temp, time);

        if (warm === null || cool === null) return null;

        // Same sign convention as the rest of the page: cooling with height is
        // negative, an inversion is positive.
        return -((warm - cool) / pair.gap);
    });
}
