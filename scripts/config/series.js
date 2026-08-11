import {pointAt} from './compass.js';
import {colour, colours} from './palette.js';

/**
 * The measurements available to chart, in the order they are offered.
 *
 * Each entry says how to find its value in a five-minute bucket, what unit it is
 * in, and how it should be drawn. `unit` is what decides which series can share
 * an axis: two series measured in ºC are directly comparable, a temperature and
 * a wind speed are not. `read` is where the API's High/Low/Avg naming is dealt
 * with once — the average is what a line should be drawn through, and the high
 * is what matters for a gust.
 *
 * This is configuration rather than code: adding a measurement the station
 * already reports is an entry here and nothing else.
 *
 * @type {Object[]}
 */
export const SERIES = [
    {
        key: 'temp',
        label: 'Temperature',
        unit: 'ºC',
        colour: colour('series-temp'),
        group: 'temp',
        on: true,
        read: row => row.uk_hybrid?.tempAvg
    },
    {
        key: 'dewpt',
        label: 'Dew point',
        unit: 'ºC',
        colour: colour('series-dewpt'),
        group: 'temp',
        on: true,
        read: row => row.uk_hybrid?.dewptAvg
    },
    {
        key: 'windSpeed',
        floor: 0,
        label: 'Wind speed',
        unit: 'km/h',
        colour: colour('series-wind'),
        group: 'wind',
        on: true,
        read: row => row.uk_hybrid?.windspeedAvg
    },
    {
        key: 'windGust',
        floor: 0,
        label: 'Wind gust',
        unit: 'km/h',
        colour: colour('series-gust'),
        group: 'wind',
        on: true,
        // Each gust is a moment, not a trend: joining them into a line would
        // draw a wind that rose and fell smoothly between peaks it never held.
        shape: 'dots',
        // The peak within the bucket: an average gust is not a gust.
        read: row => row.uk_hybrid?.windgustHigh
    },
    {
        key: 'windDir',
        label: 'Wind direction',
        unit: 'º',
        colour: colour('series-winddir'),
        group: 'direction',
        on: true,
        // A compass wraps, so 359º to 1º is one degree of change and a line
        // through it would draw a full-height fall that never happened.
        shape: 'dots',
        // Fixed to the whole compass: an auto-fitted axis makes a steady wind
        // look like it is swinging wildly.
        domain: [0, 360],
        // Read out as a compass point rather than a bearing. Everywhere else on
        // the site a direction is WSW; only here was it 224.0 º, which has to
        // be converted in the reader's head before it means anything.
        format: value => pointAt(value).abbr,
        read: row => row.winddirAvg
    },
    {
        key: 'humidity',
        floor: 0,
        label: 'Humidity',
        unit: '%',
        colour: colour('series-humidity'),
        group: 'humidity',
        read: row => row.humidityAvg
    },
    {
        key: 'pressure',
        label: 'Pressure',
        unit: 'kPa',
        colour: colour('series-pressure'),
        group: 'pressure',
        digits: 1,
        read: row => (row.uk_hybrid?.pressureMax ?? null) === null
            ? null
            : row.uk_hybrid.pressureMax / 10
    },
    {
        key: 'solar',
        floor: 0,
        label: 'Solar radiation',
        unit: 'W/m²',
        colour: colour('series-solar'),
        group: 'solar',
        on: true,
        digits: 0,
        read: row => row.solarRadiationHigh
    },
    {
        key: 'uv',
        floor: 0,
        label: 'UV index',
        unit: '',
        colour: colour('series-uv'),
        group: 'uv',
        on: true,
        digits: 1,
        read: row => row.uvHigh
    },
    {
        key: 'precipRate',
        floor: 0,
        label: 'Rain rate',
        unit: 'mm/hr',
        colour: colour('series-rain-rate'),
        group: 'precip',
        on: true,
        digits: 2,
        read: row => row.uk_hybrid?.precipRate
    },
    {
        key: 'precipTotal',
        floor: 0,
        label: 'Rain today',
        unit: 'mm',
        colour: colour('series-rain-total'),
        group: 'precip',
        on: true,
        digits: 2,
        read: row => row.uk_hybrid?.precipTotal
    }
];

/**
 * Air quality, which is not a station measurement either: it comes from a model
 * of the square the station stands in, so it is described here and assembled in
 * `air-series.js` rather than read out of a bucket.
 *
 * @type {Object}
 */
export const AIR_SERIES = {
    key: 'usAqi',
    floor: 0,
    label: 'Air quality',
    unit: 'AQI',
    colour: colour('series-air'),
    group: 'air',
    on: true,
    digits: 0
};

/**
 * What is between the station and the sun.
 *
 * Two answers to nearly the same question, which is why they share a panel and
 * an axis: both are percentages, and reading them apart is the entire point.
 * Shade is measured — how much of the sunlight that should be reaching the
 * pyranometer is not — so it counts cloud, haze, wildfire smoke and the shadow
 * of the ridge alike. Cloud is modelled, and counts only cloud.
 *
 * On a clear day the two lines sit together. When they separate, the gap is
 * everything in the air that is not cloud, which in an Okanagan August is
 * usually smoke. That gap is worth being able to see on the same chart as the
 * temperature it is holding down.
 *
 * Neither is a station column, so both are assembled in `sky-series.js` rather
 * than read out of a five-minute bucket.
 *
 * @type {Object[]}
 */
export const SKY_SERIES = [
    {
        key: 'shade',
        floor: 0,
        label: 'Shade',
        unit: '%',
        colour: colour('series-shade'),
        group: 'sky',
        digits: 0
    },
    {
        key: 'cloud',
        floor: 0,
        label: 'Cloud cover',
        unit: '%',
        colour: colour('series-cloud'),
        group: 'sky',
        digits: 0
    }
];

/**
 * The colours the lapse-rate lines cycle through. Kept apart from the station
 * measurements above because a lapse rate is not one: it belongs to a pair of
 * stations, and how many lines there are depends on how many are reporting.
 * Why these three, and not others, is in styles/palette.css with the values.
 * @type {string[]}
 */
export const LAPSE_COLOURS = colours('lapse-line-a', 'lapse-line-b', 'lapse-line-c');
