import {FORECAST_CEILING, FORECAST_COLUMN_MS, FLOOR_BELOW_FEET} from './config/rasp.js';
import {isNumber} from './lib/numbers.js';
import {binomial} from './lib/smooth.js';
import {FEET, slab, cloudBands, isotherms, flyingWindow} from './rasp.js';
import {
    convectiveDepth, climbFrom, dewpoint, temperatureAt, pressureFrom, virtualHeatFlux, LCL_PER_DEGREE
} from './lib/thermal.js';

/**
 * A forecast day, as a column of air.
 *
 * The same shape of model `buildWindgram` produces, so the same renderer draws
 * it — but built from a model rather than from thermometers, which changes
 * every source and almost none of the arithmetic.
 *
 * Where the measured windgram has three stations and has to interpolate between
 * them, this has eleven pressure levels and the model's own ground. Where it
 * has a pyranometer and has to model what share of that sunlight becomes heat,
 * this has the surface energy balance outright. And where it needs a trigger
 * offset — because a thermometer sits in the very air the parcel is made of —
 * this does not, because the model's ground temperature is the ground's.
 *
 * The calculations are the Canadian RASP's, constant for constant, and they
 * live in `lib/thermal.js` where the measured drawing reads the same ones.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * How far above the ground the modelled column is worth reading.
 *
 * The lowest pressure levels sit below the terrain in mountain country — 1000
 * hPa is at 76 m over the Okanagan, most of a kilometre under the launch — and
 * they come back with perfectly plausible numbers for air that is inside a
 * mountain. A level has to clear the ground by this much to be part of the
 * profile.
 */
const ABOVE_GROUND = 10;

/**
 * The moment local midnight fell on the first day the forecast covers.
 * @param {Object} forecast - A shaped forecast
 * @returns {number} Milliseconds
 */
function firstMidnight(forecast) {
    const local = forecast.times[0] + forecast.offset;

    return Math.floor(local / DAY) * DAY - forecast.offset;
}

/**
 * One hour of the forecast, as a column of the drawing.
 *
 * @param {Object} forecast - A shaped forecast
 * @param {number} index - Which published hour
 * @param {number} ground - The model's terrain height, in metres
 * @param {number} ceiling - The top of the drawing, in metres
 * @param {number} release - Where the parcel is let go, in metres
 * @returns {Object} A column, whose levels may be empty when the model is silent
 */
function buildColumn(forecast, index, ground, ceiling, release) {
    const {surface} = forecast;

    const temp = surface.temp[index];
    const dewpt = surface.dewpt[index];

    const aloft = forecast.levels
        .map(level => ({
            label: `${level.pressure} hPa`,
            // Kept beside the height so the pressure at any height between two
            // levels can be read back out of the column. See `pressureFrom`.
            pressure: level.pressure,
            elevation: level.heights[index],
            temp: level.temps[index],
            humidity: level.humidity[index],
            windSpeed: level.windSpeed[index],
            windDir: level.windDir[index]
        }))
        .filter(level => isNumber(level.elevation) && isNumber(level.temp)
            && level.elevation > ground + ABOVE_GROUND)
        .map(level => ({...level, dewpt: dewpoint(level.temp, level.humidity)}))
        .sort((a, b) => a.elevation - b.elevation);

    // The ground itself is the bottom of the profile. Without it the lowest
    // stability band would start hundreds of metres up, and the parcel would
    // have nothing to be released from.
    const levels = temp === null
        ? aloft
        : [{
            label: 'Surface',
            elevation: ground,
            temp,
            dewpt,
            windSpeed: surface.windSpeed[index],
            windDir: surface.windDir[index]
        }, ...aloft];

    const measured = levels.map(level => ({...level, elevationFeet: level.elevation / FEET}));

    const segments = [];
    for (let i = 0; i < measured.length - 1; i++) {
        if (measured[i].elevation >= ceiling) break;

        const rate = slab(measured[i], measured[i + 1]);
        if (!rate) continue;

        segments.push({
            from: measured[i].elevation,
            to: Math.min(measured[i + 1].elevation, ceiling),
            // Nothing here is extrapolated: the model carries the whole column,
            // so there is no boundary past which the drawing is guessing.
            extrapolated: false,
            modelled: true,
            ...rate
        });
    }

    // The virtual heat flux, which is what actually drives the buoyancy: the
    // sensible flux plus the part of the latent one that is worth something.
    const sensible = forecast.sensible[index];
    const flux = sensible === null || temp === null
        ? null
        : virtualHeatFlux(sensible, forecast.latent[index] ?? 0, temp);

    // Nothing is heating the ground, so nothing is going up — whatever the
    // profile says. The parcel calculation has no idea what time it is, and left
    // to itself it will happily report a two-thousand-metre thermal top at dusk,
    // because the air really is that unstable once the ground stops warming it.
    // The measured drawing tests the sunlight for this; here the flux is the
    // model's own answer to the same question.
    const convecting = flux !== null && flux > 0;

    // The air where the parcel is released. The model answers for its own
    // terrain, which in a valley this steep is some hundreds of metres below
    // launch — so both the temperature and the dew point are read at launch
    // height off the model's own column, the same way the measured drawing
    // releases from launch rather than from the valley floor.
    const surfaceTemp = release === ground ? temp : temperatureAt(measured, release)?.temp ?? null;

    const dewpoints = measured
        .filter(level => isNumber(level.dewpt))
        .map(level => ({elevation: level.elevation, temp: level.dewpt}));

    const releaseDew = release === ground
        ? dewpt
        : dewpoints.length ? temperatureAt(dewpoints, release)?.temp ?? null : null;

    // Null means the hour is missing; zero means the hour was answered and
    // nothing rises. Only the first should leave a gap in anything drawn.
    const depth = flux === null || surfaceTemp === null ? null
        : convecting ? convectiveDepth(measured, {release, surfaceTemp, ceiling})
            : 0;

    // Cloud base as a pilot works it out: the spread between temperature and
    // dew point where the parcel starts, times the rate at which the two
    // converge.
    const base = surfaceTemp === null || releaseDew === null
        ? null
        : release + LCL_PER_DEGREE * Math.max(0, surfaceTemp - releaseDew);

    // The pressure at the release rather than at the model's own ground, off
    // the same pressure levels the profile is read from.
    const releasePressure = release === ground
        ? surface.pressure[index]
        : pressureFrom(aloft, release) ?? surface.pressure[index];

    return {
        time: forecast.times[index],
        levels: measured,
        profile: measured,
        segments,
        above: null,
        // The climb and the two heights are all worked out from the depth, and
        // only once it has been smoothed. See `buildForecastWindgram`.
        depth,
        flux,
        temp,
        release,
        surfaceTemp,
        releasePressure,
        pressure: surface.pressure[index],
        cloudBase: base !== null && base < ceiling ? base : null,
        seaLevel: surface.seaLevel[index],
        cloud: surface.cloud[index],
        rain: surface.rain[index],
        shade: null,
        clouds: measured.length > 1
            ? cloudBands(measured, ground, measured.at(-1).elevation)
            : []
    };
}

/**
 * Builds one forecast day's drawing.
 *
 * @param {?Object} forecast - A shaped forecast from `forecast.js`
 * @param {Object} [options] - which day, where the sun is worked out for, where
 *     the parcel is released, and the floor and ceiling shared with the other
 *     drawings
 * @returns {?Object} A model the windgram can draw, or null when the day is empty
 */
export function buildForecastWindgram(forecast, {day = 0, latitude, longitude, frame, release} = {}) {
    if (!forecast?.times?.length || !isNumber(forecast.elevation)) return null;
    if (!forecast.levels?.length) return null;

    const midnight = firstMidnight(forecast) + day * DAY;

    // The same daylight window the measured drawing uses, worked out for the
    // day being forecast rather than for today — tomorrow's sun is a couple of
    // minutes different, and in spring or autumn a good deal more.
    const {dayStart, lastTime} = flyingWindow(midnight, forecast.offset, latitude, longitude);

    const hours = forecast.times
        .map((time, index) => ({time, index}))
        .filter(hour => hour.time >= dayStart && hour.time <= lastTime);

    // A day the model does not reach. The second tab hits this in the hours
    // after a run publishes, before the next one extends the horizon.
    if (!hours.length) return null;

    const ground = forecast.elevation;

    const {floor, ceiling} = frame ?? {
        floor: ground - FLOOR_BELOW_FEET * FEET,
        ceiling: FORECAST_CEILING
    };

    // Released from launch where the page knows where launch is, and from the
    // model's own terrain otherwise.
    //
    // This matters more than it sounds. The model's ground for Cooper's is
    // several hundred metres below the launch, and a parcel released down there
    // spends a summer morning under the valley inversion — correctly, and
    // uselessly, because nobody launches from inside it. Releasing both drawings
    // from the same height is most of what made the measured day and the
    // forecast disagree about the same afternoon.
    const parcelFrom = isNumber(release) ? Math.max(ground, release) : ground;

    const columns = hours.map(hour =>
        buildColumn(forecast, hour.index, ground, ceiling, parcelFrom));

    // Nothing but empty columns is not a day worth drawing; it is a gap the
    // model left, and the panel says so rather than showing an empty frame.
    if (!columns.some(column => column.segments.length)) return null;

    // Smoothed before anything is derived from them, rather than after.
    //
    // Both of these are crossings — the height where two curves meet — and a
    // tenth of a degree of wobble in the profile steps them hundreds of metres.
    // The RASP smooths its cloudbase and its top of lift for exactly that
    // reason. This goes one step further back and smooths the layer depth
    // itself, which is the input all three of the climb figures are built from,
    // for two reasons.
    //
    // It is more consistent: smoothing the outputs separately let the climb
    // line drift above the cloudbase it is supposed to stop at, because two
    // series smoothed apart do not keep the order between them.
    //
    // And it draws the air the way the air behaves. An afternoon shower drops
    // the ground temperature four degrees in an hour while the air aloft stays
    // warm, so the parcel calculation reports a boundary layer that steps from
    // three kilometres to nothing and back inside two hours. A real convective
    // layer does not vanish and re-form on the hour — it thins, and it leaves a
    // residual layer behind. Smoothing turns that cliff into the deep trough it
    // really is, which still says "not four o'clock" without claiming the sky
    // switched off.
    ['depth', 'cloudBase'].forEach(field => {
        const smoothed = binomial(columns.map(column => column[field]));
        columns.forEach((column, index) => { column[field] = smoothed[index]; });
    });

    columns.forEach(column => {
        // One derivation, shared with the measured drawing: see `climbFrom`.
        // Smoothing can carry a little depth into an hour whose ground has
        // already stopped warming — the evening, most often — and the flux is
        // the gate on whether anything rises at all, which is tested in there.
        Object.assign(column, climbFrom(column.depth, {
            release: column.release,
            surfaceTemp: column.surfaceTemp,
            flux: column.flux,
            pressure: column.releasePressure,
            cloudBase: column.cloudBase
        }));

        // The strip wants the sea-level pressure; the physics wanted the
        // surface one. Only the first is drawn.
        column.pressure = column.seaLevel;
    });

    return {
        dayStart,
        lastTime,
        floor,
        ground,
        ceiling,
        offset: forecast.offset,
        columnMs: FORECAST_COLUMN_MS,
        // Nothing on the hillside is standing in this air, so there is no
        // station to name on the altitude axis or against a barb.
        stations: [],
        latitude,
        longitude,
        modelledAloft: true,
        columns,
        isotherms: isotherms(columns, ceiling)
    };
}
