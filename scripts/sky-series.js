import {sunHeight, clearSky, shadeFraction} from './lib/solar.js';
import {isNumber} from './lib/numbers.js';
import {valueAt} from './lib/series-time.js';

/**
 * What was between the station and the sun, through the day.
 *
 * The windgram has carried both of these for a while, but only in its own
 * strips, half an hour at a time. Here they are put on the ordinary chart at the
 * station's own reading times, where they can be read against the temperature
 * they were holding down.
 *
 * Neither is a column the station logs. Shade is worked out from the sunlight it
 * did log, against how much should have been arriving at that place and moment;
 * cloud is the model's, sampled onto the same times.
 */

// An hour either side, matching the sounding: the model publishes hourly and
// the last reading of the day can sit most of an hour past its last hour.
const ALIGN_TOLERANCE = 60 * 60 * 1000;

/**
 * How much of the sunlight went missing, reading by reading.
 *
 * Not smoothed, unlike the windgram's version of the same figure. A chart drawn
 * at five-minute resolution shows every other measurement raw, and a cloud
 * crossing the sun for ten minutes is a real event rather than noise — the whole
 * reason to plot this against wind and temperature is to catch exactly that.
 *
 * @param {?Object} day - A day from the history reader
 * @param {number} latitude - Degrees north, from the station's own observation
 * @param {number} longitude - Degrees east
 * @returns {?number[]} Percentages, with gaps where it cannot be read honestly
 */
export function shadeColumn(day, latitude, longitude) {
    if (!day?.times?.length || !day.values?.solar) return null;
    if (!isNumber(latitude) || !isNumber(longitude)) return null;

    const column = day.times.map((time, index) => {
        const solar = day.values.solar[index];
        if (!isNumber(solar)) return null;

        // Near dawn and dusk the clear-sky figure is too small to divide by, and
        // the solar module answers null rather than a number it cannot stand
        // behind. That stays a gap here.
        const shade = shadeFraction(Number(solar), clearSky(sunHeight(time, latitude, longitude), time));

        return shade === null ? null : shade * 100;
    });

    return column.some(value => value !== null) ? column : null;
}

/**
 * The modelled cloud cover, at the station's own reading times.
 *
 * A staircase rather than a curve, for the same reason the air quality line is:
 * the model publishes one value an hour, and drawing a slope between them would
 * invent a clearing that was never forecast.
 *
 * @param {?Object} aloft - A model from the sounding service
 * @param {number[]} times - The times to sample at, in milliseconds
 * @returns {?number[]} Percentages, with gaps where the model says nothing
 */
export function cloudColumn(aloft, times) {
    if (!aloft?.times?.length || !aloft.cloud) return null;

    const column = times.map(time => valueAt(aloft.times, aloft.cloud, time, ALIGN_TOLERANCE));

    return column.some(value => value !== null) ? column : null;
}
