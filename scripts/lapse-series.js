import {LAPSE_COLOURS} from './config/series.js';
import {lapseRate, pairByElevation, MINIMUM_GAP} from './lib/lapse.js';
import {valueAt} from './lib/series-time.js';

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

/**
 * Builds one lapse-rate series per adjacent pair of stations.
 *
 * A station with no day logged drops out and lets its neighbours pair up.
 *
 * @param {Object[]} entries - Station entries, each with its station, elevation and day
 * @returns {Object[]} Series definitions, each carrying its own column builder
 */
export function lapsePairs(entries) {
    const charted = entries.filter(entry =>
        entry.day?.values?.temp && Number.isFinite(entry.elevation));

    const pairs = [];

    pairByElevation(charted, entry => entry.elevation).forEach(({upper, lower}) => {
        const gap = (upper.elevation - lower.elevation) / 1000;

        // Two stations at the same height cannot describe a lapse between them.
        if (Math.abs(gap) < MINIMUM_GAP) return;

        pairs.push({
            key: `lapse_${pairs.length}`,
            label: `${upper.station.shortName} → ${lower.station.shortName}`,
            unit: 'ºC/1000 ft',
            colour: LAPSE_COLOURS[pairs.length % LAPSE_COLOURS.length],
            group: 'lapse',
            on: true,
            digits: 2,
            // Drawn upside down: a lapse rate is negative when the air cools
            // with height, and that is the condition worth flying, so it reads
            // better climbing the panel than falling down it.
            invert: true,
            upper,
            lower,
            gap
        });
    });

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
        const warm = valueAt(pair.lower.day.times, pair.lower.day.values.temp, time, ALIGN_TOLERANCE);
        const cool = valueAt(pair.upper.day.times, pair.upper.day.values.temp, time, ALIGN_TOLERANCE);

        if (warm === null || cool === null) return null;

        return lapseRate(warm, cool, pair.gap);
    });
}
