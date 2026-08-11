import {valueAt} from './lib/series-time.js';

/**
 * Air quality, through the day.
 *
 * The station logs every five minutes and the air quality model publishes every
 * hour, so the two do not line up and cannot be drawn on the same axis until one
 * of them is asked about the other's times. That is all this does: for each of
 * the station's reading times, the hour that covers it.
 *
 * The result is a staircase rather than a curve, which is the honest shape. The
 * model has one value per hour; drawing a smooth line between them would invent
 * a rise and fall it never published.
 */

// Half an hour either side, so every moment lands on the hour nearest it and
// none lands on nothing. Wider than this and the last hour of the response
// would go on answering for the rest of the evening.
const ALIGN_TOLERANCE = 30 * 60 * 1000;

/**
 * Works the air quality out across one station's own reading times.
 * @param {?Object} air - A reading from the air quality service
 * @param {number[]} times - The times to sample at, in milliseconds
 * @returns {?number[]} One value per time, with gaps where the model says nothing
 */
export function airColumn(air, times) {
    if (!air?.times?.length) return null;

    return times.map(time => valueAt(air.times, air.hourly.usAqi, time, ALIGN_TOLERANCE));
}
