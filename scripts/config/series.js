import {pointAt} from './compass.js';

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
        colour: '#d92c2c',
        group: 'temp',
        on: true,
        read: row => row.uk_hybrid?.tempAvg
    },
    {
        key: 'dewpt',
        label: 'Dew point',
        unit: 'ºC',
        colour: '#2f8f46',
        group: 'temp',
        on: true,
        read: row => row.uk_hybrid?.dewptAvg
    },
    {
        key: 'windSpeed',
        floor: 0,
        label: 'Wind speed',
        unit: 'km/h',
        colour: '#1668b0',
        group: 'wind',
        on: true,
        read: row => row.uk_hybrid?.windspeedAvg
    },
    {
        key: 'windGust',
        floor: 0,
        label: 'Wind gust',
        unit: 'km/h',
        colour: '#e07b1f',
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
        // Slate rather than another blue: wind speed is already blue, and in
        // the overlay the two were near enough to be taken for one line.
        colour: '#4b5563',
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
        colour: '#0f8f8f',
        group: 'humidity',
        read: row => row.humidityAvg
    },
    {
        key: 'pressure',
        label: 'Pressure',
        unit: 'kPa',
        colour: '#7a4fbf',
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
        colour: '#e0a81f',
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
        colour: '#8f2f8f',
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
        colour: '#7ac043',
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
        colour: '#2f9fd0',
        group: 'precip',
        on: true,
        digits: 2,
        read: row => row.uk_hybrid?.precipTotal
    }
];

/**
 * The colours the lapse-rate lines cycle through. Kept apart from the station
 * measurements above because a lapse rate is not one: it belongs to a pair of
 * stations, and how many lines there are depends on how many are reporting.
 * @type {string[]}
 */
export const LAPSE_COLOURS = ['#b5442f', '#0f7d8f', '#8a5a12'];
