import * as readings from '../readings.js';

/**
 * The secondary readings, in reading order.
 *
 * Each tile is described rather than written out: its label, its icon, the unit
 * it is shown in, and how to find its value and its note. The weather page
 * walks this list, so adding a tile or moving one is an edit here and nothing
 * else — the renderer never learns what a dew point is.
 *
 * `unit` may be a string or a function, because pressure has no unit to show
 * when the station does not report it, and "— kPa" reads as a measurement
 * rather than as a missing one.
 *
 * @type {Object[]}
 */
export const READOUTS = [
    {
        label: 'Temperature',
        icon: 'device_thermostat',
        unit: 'ºC',
        read: observation => readings.temperature(observation).celsius
    },
    {
        label: 'Dew Point',
        icon: 'opacity',
        unit: 'ºC',
        read: (observation, metrics) => metrics.dewPoint?.celsius,
        note: (observation, metrics) => metrics.dewPoint?.description
    },
    {
        label: 'Humidity',
        icon: 'humidity_percentage',
        unit: '%',
        read: (observation, metrics) => metrics.humidity?.percent,
        note: (observation, metrics) => metrics.humidity?.description
    },
    {
        label: 'Heat Index',
        icon: 'wb_sunny',
        unit: 'ºC',
        read: (observation, metrics) => metrics.heatIndex?.celsius,
        note: (observation, metrics) => metrics.heatIndex?.description
    },
    {
        label: 'Wind Chill',
        icon: 'ac_unit',
        unit: 'ºC',
        read: (observation, metrics) => metrics.windChill?.celsius,
        note: (observation, metrics) => metrics.windChill?.description
    },
    {
        label: 'Barometric Pressure',
        icon: 'speed',
        unit: (observation, metrics) => metrics.barometricPressure ? 'kPa' : '',
        read: (observation, metrics) => metrics.barometricPressure?.kPa,
        note: (observation, metrics) =>
            metrics.barometricPressure?.description ?? 'This station does not report pressure.'
    },
    {
        label: 'UV Index',
        icon: 'light_mode',
        read: observation => observation.uv,
        note: (observation, metrics) => metrics.uvIndex
            ? `${metrics.uvIndex.risk} — ${metrics.uvIndex.description}`
            : null
    },
    {
        label: 'Solar Radiation',
        icon: 'brightness_7',
        unit: 'W/m²',
        read: observation => observation.solarRadiation
    },
    {
        label: 'Rainfall',
        icon: 'water_drop',
        unit: 'mm',
        read: observation => readings.rainfall(observation).millimetres,
        note: () => 'Total so far today'
    },
    {
        label: 'Precipitation Rate',
        icon: 'grain',
        unit: 'mm/hr',
        read: observation => readings.precipitationRate(observation).rate
    }
];
