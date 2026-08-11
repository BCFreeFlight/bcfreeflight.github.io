import {
    COLUMN_MS, CEILING, ISOTHERM_STEP, CLOUD_DEPRESSION,
    FLOOR_BELOW_FEET, CEILING_ABOVE_FEET, MINIMUM_DEPTH,
    SUN_MARGIN_MS, WINDOW_STEP_MS, FORECAST_WINDOW
} from './config/rasp.js';
import {LAPSE} from './config/bands.js';
import {band, isNumber} from './lib/numbers.js';
import {lapseRate, MINIMUM_GAP} from './lib/lapse.js';
import {binomial} from './lib/smooth.js';
import {sunHeight, clearSky, shadeFraction, sunTimes} from './lib/solar.js';
import {temperatureAt, thermalTop, updraft, heatFlux, climbTop, LCL_PER_DEGREE} from './lib/thermal.js';
import sounding from './sounding.js';

/**
 * The day, as a column of air.
 *
 * Every other chart on the site plots one station against time. This one plots
 * the whole hillside against time: the stations stop being three separate lines
 * and become three heights in a single profile, which is how a soaring forecast
 * is actually read. What is between them is interpolated, what is above them is
 * extrapolated, and the model says which is which so the drawing can too.
 *
 * The model is built once and handed to the renderer. Nothing in here knows
 * about pixels, and nothing in the renderer knows about lapse rates.
 */

/** Weather Underground reports elevation in feet; the physics is all metric. */
export const FEET = 0.3048;

// How finely the cloud and profile fields are sampled up the column. Fine
// enough that a cloud band lands on the right side of a station, coarse enough
// that a day of columns is still a few thousand samples.
const SAMPLE_STEP = 60;

// A modelled level closer than this to a station is dropped: the station owns
// that height, and two levels a few metres apart make a slab with no depth to
// take a colour.
const MINIMUM_SEPARATION = 40;

/**
 * Over how long the temperature is averaged before the air between two stations
 * is judged.
 *
 * A lapse rate is a difference between two thermometers a few hundred metres
 * apart, so a tenth of a degree of noise at either end moves it by more than
 * the width of a stability band. Left raw, the drawing comes out striped —
 * every column a slightly different colour from its neighbours — which reads as
 * the air changing every half hour when it is really the sensors twitching.
 *
 * An hour and a half is about how fast the stability of a mountain afternoon
 * actually changes. Written as a duration rather than as a number of columns,
 * so that changing how wide a column is does not silently change how hard the
 * drawing is smoothed.
 */
const SMOOTH_MINUTES = 90;

/**
 * How much sunlight has to be landing before the drawing will claim a thermal.
 *
 * The parcel calculation has no idea what time it is: give it a trigger offset
 * and a lapse rate and it will happily report a two-thousand-metre thermal top
 * at three in the morning, because the air overnight really is that unstable —
 * there is simply nothing heating the ground to set a bubble off. Requiring
 * real sunlight is what turns an arithmetic result back into a forecast.
 */
const THERMAL_SUN = 60;

// Sunlight is smoothed less: a cloud crossing the sun is a real event on this
// timescale, not noise, and over-smoothing it would flatten the cloud strip.
const SMOOTH_SOLAR_MINUTES = 30;

/**
 * A smoothing window in columns, from one in minutes. Always odd, so the
 * average is centred on the reading it replaces rather than half a column off.
 * @param {number} minutes - How long to average over
 * @returns {number} A column count of at least one
 */
function window(minutes) {
    const columns = Math.round(minutes * 60000 / COLUMN_MS);
    return Math.max(1, columns % 2 ? columns : columns + 1);
}

/**
 * A rolling average down a column of readings, gaps left as gaps.
 *
 * Centred rather than trailing, because this is a chart of a day that has
 * already happened: there is no reason to lag it the way a live indicator
 * would have to.
 *
 * @param {Array<?number>} values - The readings, in order
 * @param {number} span - How many columns to average over
 * @returns {Array<?number>} The smoothed readings
 */
function smooth(values, span) {
    const reach = Math.floor(span / 2);

    return values.map((value, index) => {
        // A gap stays a gap: averaging across one would invent a reading for a
        // time when the station was dark.
        if (value === null) return null;

        let sum = 0;
        let count = 0;

        for (let i = Math.max(0, index - reach); i <= Math.min(values.length - 1, index + reach); i++) {
            if (values[i] === null) continue;
            sum += values[i];
            count += 1;
        }

        return count ? sum / count : null;
    });
}

/**
 * Averages one station's day into fixed-width columns.
 *
 * Averaging rather than sampling is what keeps a single gusty five-minute
 * bucket from setting the direction of a whole column, and it is why direction
 * is averaged as a vector: the mean of 350º and 10º is north, not south.
 *
 * @param {Object} day - A day from the history reader
 * @param {number} dayStart - The moment the first column starts
 * @param {number} count - How many columns to fill
 * @returns {Object[]} One aggregate per column, with nulls where nothing logged
 */
function columnise(day, dayStart, count) {
    const fields = ['temp', 'dewpt', 'windSpeed', 'pressure', 'solar', 'precipRate'];

    const buckets = Array.from({length: count}, () => ({
        sums: {}, counts: {}, east: 0, north: 0, weight: 0, headings: 0
    }));

    day.times.forEach((time, index) => {
        const slot = Math.floor((time - dayStart) / COLUMN_MS);
        if (slot < 0 || slot >= count) return;

        const bucket = buckets[slot];

        fields.forEach(field => {
            const value = day.values[field]?.[index];
            if (!isNumber(value)) return;

            bucket.sums[field] = (bucket.sums[field] ?? 0) + Number(value);
            bucket.counts[field] = (bucket.counts[field] ?? 0) + 1;
        });

        const heading = day.values.windDir?.[index];
        if (!isNumber(heading)) return;

        // Weighted by the wind that was actually blowing, so ten minutes of
        // calm does not drag the direction of a strong breeze around.
        const speed = day.values.windSpeed?.[index];
        const weight = isNumber(speed) ? Math.max(Number(speed), 0.1) : 1;
        const radians = Number(heading) * Math.PI / 180;

        bucket.east += weight * Math.sin(radians);
        bucket.north += weight * Math.cos(radians);
        bucket.weight += weight;
        bucket.headings += 1;
    });

    const columns = buckets.map(bucket => {
        const column = {};

        fields.forEach(field => {
            column[field] = bucket.counts[field]
                ? bucket.sums[field] / bucket.counts[field]
                : null;
        });

        if (!bucket.headings) {
            column.windDir = null;
        } else {
            const degrees = Math.atan2(bucket.east, bucket.north) * 180 / Math.PI;
            column.windDir = (degrees + 360) % 360;
        }

        return column;
    });

    // Smoothed after the columns are formed rather than before, so a station
    // that logs every five minutes and one that logs every half hour are
    // smoothed over the same amount of time rather than the same number of
    // readings.
    [['temp', SMOOTH_MINUTES], ['dewpt', SMOOTH_MINUTES], ['solar', SMOOTH_SOLAR_MINUTES]]
        .forEach(([field, minutes]) => {
            const smoothed = smooth(columns.map(column => column[field]), window(minutes));
            columns.forEach((column, index) => { column[field] = smoothed[index]; });
        });

    return columns;
}

/**
 * The stability of one slab of air, as the site already describes stability.
 * @param {Object} lower - The level below, with elevationFeet and temp
 * @param {Object} upper - The level above
 * @returns {?Object} rate and the band it falls in, or null for a zero gap
 */
export function slab(lower, upper) {
    const gap = (upper.elevationFeet - lower.elevationFeet) / 1000;
    if (Math.abs(gap) < MINIMUM_GAP) return null;

    const rate = lapseRate(lower.temp, upper.temp, gap);

    return {rate, band: band(LAPSE, rate)};
}


/**
 * How far above the top station the model is still pulled towards it, in metres.
 *
 * The top station and the model rarely agree about the temperature at the top
 * station's own height — today Silver Star reads nearly four degrees warmer than
 * HRDPS thinks the air there is, which is an ordinary amount for a thermometer
 * on a ski hill against a 2.5 km grid square. Spliced together raw, that
 * disagreement became a four-degree step at exactly 1,662 m, and the drawing
 * rendered the step as a superadiabatic slab: a bright red band sitting on the
 * top station all afternoon, which was an artefact of the join and not a
 * property of the air.
 *
 * So the correction is carried upward and faded out. A thermometer's quarrel
 * with a model is mostly about the ground it is standing on, and that influence
 * does not reach far: a kilometre above it the model is on its own.
 */
const OFFSET_FADE = 1000;

/**
 * The modelled column, moved onto the measured one.
 *
 * The model knows the shape of the air — where the inversion sits, how deep it
 * is, where it breaks — far better than three thermometers strung up a hillside
 * can. What it does not know is the temperature *here*: its grid square is
 * 2.5 km across and its idea of the ground is a smoothed version of a valley
 * that is neither smooth nor a single height.
 *
 * So this takes the shape and keeps the readings. Each station's disagreement
 * with the model at its own height is measured, and the model's profile is
 * shifted by those disagreements — blended linearly between one station and the
 * next, so the corrected profile passes exactly through every reading and takes
 * the model's structure in between. Above the top station the last correction
 * fades out over `OFFSET_FADE`.
 *
 * The alternative, and what this replaces, was a straight line between one
 * station and the next: a 561-metre slab of a single colour, which cannot show
 * an inversion that is a hundred metres deep and cannot show it breaking.
 *
 * @param {Object[]} stations - Ascending measured levels, with elevation and temp
 * @param {Object[]} modelled - Ascending modelled levels, with elevation and temp
 * @returns {Object[]} The modelled levels, corrected, ready to merge
 */
export function anchored(stations, modelled) {
    if (!stations.length || !modelled.length) return [];

    // What each station says the model is out by, at its own height.
    const errors = stations.map(station => ({
        elevation: station.elevation,
        error: station.temp - (temperatureAt(modelled, station.elevation)?.temp ?? station.temp)
    }));

    const top = errors.at(-1);

    /**
     * @param {number} height - Metres above sea level
     * @returns {number} How much to move the model by, in ºC
     */
    const correction = height => {
        if (height <= errors[0].elevation) return errors[0].error;

        for (let i = 0; i < errors.length - 1; i++) {
            const below = errors[i];
            const above = errors[i + 1];
            if (height > above.elevation) continue;

            const share = (height - below.elevation) / (above.elevation - below.elevation);

            return below.error + share * (above.error - below.error);
        }

        // Above the top station, fading to nothing.
        const reach = Math.min(1, (height - top.elevation) / OFFSET_FADE);

        return top.error * (1 - reach);
    };

    const highest = stations.at(-1).elevation;

    return modelled
        // A level a station is standing on is the station's; there is nothing
        // for the model to add at a height something is measuring.
        .filter(level => stations.every(station =>
            Math.abs(level.elevation - station.elevation) > MINIMUM_SEPARATION))
        .map(level => ({
            ...level,
            temp: level.temp + correction(level.elevation),
            elevationFeet: level.elevation / FEET,
            // Only the air above the top station is a guess about somewhere
            // nothing is reporting from. Between the stations the model is
            // shaping a column that is anchored at both ends.
            aloft: level.elevation > highest
        }));
}

/**
 * The height at which the air is a given temperature.
 *
 * Walked from the ground up and answered at the first crossing, because on a
 * day with an inversion the profile is not monotonic and the isotherm a pilot
 * cares about is the low one.
 *
 * @param {Object[]} levels - Ascending {elevation, temp}, in metres
 * @param {number} value - The temperature to find, in ºC
 * @param {number} ceiling - How far above the top station to keep looking
 * @returns {?number} Height in metres, or null when the air is never that warm
 */
function heightAtTemperature(levels, value, ceiling) {
    if (levels.length < 2) return null;

    const spans = [];
    for (let i = 0; i < levels.length - 1; i++) {
        spans.push([levels[i], levels[i + 1]]);
    }

    // The extrapolated slab above the top station, continued at the gradient
    // measured between the top two.
    const top = levels.at(-1);
    const below = levels.at(-2);
    const gradient = (top.temp - below.temp) / (top.elevation - below.elevation);
    spans.push([top, {elevation: ceiling, temp: top.temp + gradient * (ceiling - top.elevation)}]);

    for (const [lower, upper] of spans) {
        const low = Math.min(lower.temp, upper.temp);
        const high = Math.max(lower.temp, upper.temp);

        if (value < low || value > high) continue;
        if (Math.abs(upper.temp - lower.temp) < 1e-9) return lower.elevation;

        const fraction = (value - lower.temp) / (upper.temp - lower.temp);
        return lower.elevation + fraction * (upper.elevation - lower.elevation);
    }

    return null;
}

/**
 * Where the air is close enough to saturation to be cloud.
 *
 * Temperature and dew point are each interpolated up the column and subtracted,
 * so a band appears wherever the spread between them closes — which, with three
 * levels, is a coarse answer to a question a sounding answers finely. It is
 * drawn as hatching rather than as solid cloud for exactly that reason.
 *
 * Deliberately stops at the highest station rather than running to the top of
 * the drawing. Above there, both the temperature and the dew point are being
 * continued at their own measured gradients, and two straight lines with
 * different slopes always meet: the extrapolation would confidently hatch a
 * cloud layer into air nothing has measured, at whatever height the arithmetic
 * happened to cross.
 *
 * @param {Object[]} levels - Ascending levels carrying temp and dewpt
 * @param {number} ground - The lowest station, in metres
 * @param {number} top - The highest station, in metres
 * @returns {Object[]} Bands of {from, to}, in metres
 */
export function cloudBands(levels, ground, top) {
    const damp = levels.filter(level => isNumber(level.dewpt));
    if (damp.length < 2) return [];

    const dewpoints = damp.map(level => ({elevation: level.elevation, temp: level.dewpt}));
    const bands = [];
    let open = null;

    for (let height = ground; height <= top; height += SAMPLE_STEP) {
        const air = temperatureAt(levels, height);
        const dew = temperatureAt(dewpoints, height);
        const saturated = air && dew && air.temp - dew.temp < CLOUD_DEPRESSION;

        if (saturated && !open) {
            open = {from: height, to: height};
        } else if (saturated) {
            open.to = height;
        } else if (open) {
            bands.push(open);
            open = null;
        }
    }

    if (open) bands.push(open);

    return bands;
}

const HOUR = 60 * 60 * 1000;

/**
 * The hours every windgram on the panel is drawn across.
 *
 * The sun sets the window rather than the clock, because the question all three
 * are answering is about a flying day and a flying day is bounded by daylight —
 * which moves through the year, and moves differently at different latitudes.
 * An hour of margin either side catches the morning inversion breaking and the
 * evening shutting down.
 *
 * Rounded to the half hour on the site's own clock rather than in UTC, so the
 * axis reads in round numbers everywhere and not only in the timezones that
 * happen to sit a whole number of hours off it.
 *
 * @param {number} midnight - Local midnight of the day being drawn
 * @param {number} offset - The site's offset from UTC, in milliseconds
 * @param {number} latitude - Degrees north
 * @param {number} longitude - Degrees east
 * @returns {Object} dayStart and lastTime, in milliseconds
 */
export function flyingWindow(midnight, offset, latitude, longitude) {
    // Noon, so the answer is this day's sun rather than the edge of it.
    const {sunrise, sunset} = sunTimes(midnight + 12 * HOUR, latitude, longitude);

    // No sunrise to measure from, which happens inside the arctic circle in
    // either direction. The clock is all that is left.
    if (!Number.isFinite(sunrise) || !Number.isFinite(sunset)) {
        return {
            dayStart: midnight + FORECAST_WINDOW.startHour * HOUR,
            lastTime: midnight + FORECAST_WINDOW.endHour * HOUR
        };
    }

    const round = at => Math.round((at + offset) / WINDOW_STEP_MS) * WINDOW_STEP_MS - offset;

    return {dayStart: round(sunrise - SUN_MARGIN_MS), lastTime: round(sunset + SUN_MARGIN_MS)};
}

/**
 * The frame every windgram on the panel is drawn in.
 *
 * The measured day and the two forecasts were each sizing themselves to their
 * own contents, which made them impossible to read against one another: the
 * same thermal top landed at a different height in each, and the measured
 * drawing's fixed ceiling quietly clipped its own answer. One frame, built from
 * all of them, fixes both.
 *
 * @param {Array<?Object>} models - The drawings that will share the frame
 * @param {number} lowest - The lowest station's elevation, in metres
 * @returns {Object} floor and ceiling, in metres above sea level
 */
export function sharedFrame(models, lowest) {
    const floor = lowest - FLOOR_BELOW_FEET * FEET;

    // The top of the lift, across every drawing that will share this frame.
    // Taken from all of them together so that switching between the day so far
    // and the two forecasts moves the weather and not the axis: a climb that is
    // higher tomorrow should look higher, not fill the same panel.
    const tops = models
        .filter(Boolean)
        .flatMap(model => model.columns.map(column => column.thermalTop))
        .filter(isNumber);

    const ceiling = tops.length
        ? Math.max(...tops) + CEILING_ABOVE_FEET * FEET
        : floor + MINIMUM_DEPTH;

    return {floor, ceiling: Math.max(ceiling, floor + MINIMUM_DEPTH)};
}

/**
 * Builds the whole drawing's model from the days already read for each station.
 *
 * @param {Object[]} entries - {station, elevationFeet, latitude, longitude, day}
 * @param {?Object} [modelled] - The modelled air above the stations, when it is known
 * @param {?Object} [frame] - The floor and ceiling shared with the other
 *     drawings. Left out, the drawing sizes itself to its own stations, which
 *     is right for a windgram that is the only one on the page.
 * @returns {?Object} The model, or null when there is nothing to draw
 */
export function buildWindgram(entries, modelled = null, frame = null) {
    const charted = entries
        .filter(entry => entry.day?.times?.length && Number.isFinite(entry.elevationFeet))
        .sort((a, b) => a.elevationFeet - b.elevationFeet);

    if (!charted.length) return null;

    const midnight = Math.min(...charted.map(entry => entry.day.dayStart));

    // Solar position is worked out at the lowest station: the three are within
    // ten kilometres of each other, which is a rounding error at this scale.
    const {latitude, longitude} = charted[0];

    // The same daylight window the forecasts use, so the three can be read
    // against one another. The part of it that has not happened yet is drawn as
    // the gap it is rather than by stopping the axis at the last reading, which
    // used to make the measured day a different width from every other drawing
    // and a different width again every half hour.
    const {dayStart, lastTime} = flyingWindow(
        midnight, charted[0].day.offset, latitude, longitude);

    const count = Math.max(1, Math.ceil((lastTime - dayStart) / COLUMN_MS));

    const aggregated = charted.map(entry => columnise(entry.day, dayStart, count));

    // One barometer for the whole strip.
    //
    // The three stations do not agree about what "pressure" means: one of them
    // reports what its own sensor reads at its own height, another reports the
    // sea-level equivalent, and the third has no barometer at all. Taking
    // whichever station happened to report in a given column drew a six
    // kilopascal cliff at the moment one came online. So the station with the
    // most readings is chosen once, and the strip is its trace or nothing.
    const barometer = aggregated
        .map((station, index) => ({
            index,
            readings: station.filter(column => isNumber(column.pressure)).length
        }))
        .sort((a, b) => b.readings - a.readings)[0];

    const pressures = barometer?.readings ? aggregated[barometer.index] : null;

    const ground = charted[0].elevationFeet * FEET;

    const {floor, ceiling} = frame ?? {
        floor: ground - FLOOR_BELOW_FEET * FEET,
        ceiling: Math.max(CEILING, charted.at(-1).elevationFeet * FEET + 500)
    };

    /**
     * Where a thermal is taken to start.
     *
     * Not the lowest station, which is the obvious choice and the wrong one.
     * The valley floor spends a summer morning under an inversion — often
     * sitting in its own fog — and a parcel released into that is capped within
     * a couple of hundred metres, correctly. But nobody launches from inside an
     * inversion. Releasing from the valley made the lift strip collapse at the
     * moment the valley station came online, which said more about which
     * sensors were awake than about the day.
     *
     * So the parcel is released from the site's own launch, and the drawing
     * says so underneath. What is below launch still shapes the picture — the
     * inversion is drawn, in its own colour, where it actually is.
     */
    const launch = charted.find(entry => entry.station.isDefault) ?? charted[0];
    const launchElevation = launch.elevationFeet * FEET;

    const columns = [];

    for (let i = 0; i < count; i++) {
        const time = dayStart + (i + 0.5) * COLUMN_MS;

        const levels = charted
            .map((entry, station) => ({
                key: entry.station.key,
                elevationFeet: entry.elevationFeet,
                elevation: entry.elevationFeet * FEET,
                ...aggregated[station][i]
            }))
            .filter(level => isNumber(level.temp));

        // The measured column, shaped by the model between the stations and
        // continued by it above them. The readings are never overwritten — see
        // `anchored`, which moves the model onto them rather than the other way
        // round — so a thermometer still wins at its own height.
        const overhead = levels.length
            ? anchored(levels, sounding.profileAt(modelled, time, levels[0].elevation))
            : [];

        const profile = [...levels, ...overhead].sort((a, b) => a.elevation - b.elevation);

        const segments = [];
        for (let level = 0; level < profile.length - 1; level++) {
            if (profile[level].elevation >= ceiling) break;

            const measured = slab(profile[level], profile[level + 1]);
            if (!measured) continue;

            segments.push({
                from: profile[level].elevation,
                // Clipped, so a model level well above the drawing does not
                // stretch the last band off the top of it.
                to: Math.min(profile[level + 1].elevation, ceiling),
                // Knocked back only above the top station. A modelled level
                // between two stations is bracketed by readings at both ends,
                // which is a different and much better-supported claim than one
                // above everything that is reporting.
                extrapolated: Boolean(profile[level + 1].aloft),
                modelled: Boolean(profile[level + 1].modelled),
                ...measured
            });
        }

        // With no model to continue it, the last measured gradient is all there
        // is, so it is carried upward the way it always was — separately, so it
        // can be drawn as the guess it is rather than as another measurement.
        const above = !overhead.some(level => level.aloft) && segments.length
            ? {
                from: levels.at(-1).elevation,
                to: ceiling,
                rate: segments.at(-1).rate,
                band: segments.at(-1).band,
                extrapolated: true
            }
            : null;

        const solar = Math.max(
            ...aggregated.map(station => station[i].solar).filter(isNumber),
            Number.NEGATIVE_INFINITY
        );

        const irradiance = Number.isFinite(solar) ? solar : null;
        const height = sunHeight(time, latitude, longitude);
        const shade = shadeFraction(irradiance, clearSky(height, time));

        const sunlit = irradiance !== null && irradiance >= THERMAL_SUN;

        // The profile from launch upward, measured as far as the stations reach
        // and modelled above them. Anything below launch is drawn, but it is not
        // what the bubble climbs through.
        const climbing = profile.filter(level => level.elevation >= launchElevation - 1);
        const surface = climbing[0] ?? profile[0];

        const top = sunlit ? thermalTop(climbing, ceiling) : null;

        // How much of that sunlight becomes heat in the air. The sunlight is
        // always the station's own pyranometer; only the share is modelled,
        // because how wet the ground is is not something a weather station can
        // report and it is what decides the strength of the day.
        const flux = heatFlux(irradiance, sounding.shareAt(modelled, time));

        const lift = top !== null && flux !== null
            ? updraft(top - surface.elevation, flux, surface.temp, surface.elevation)
            : null;

        // Cloud base as a pilot works it out: the spread between temperature
        // and dew point at the surface, times the rate the two converge.
        const base = surface && isNumber(surface.dewpt)
            ? surface.elevation + LCL_PER_DEGREE * Math.max(0, surface.temp - surface.dewpt)
            : null;

        // How high a wing still climbs, which is lower than where the bubble
        // stops — and lower again when there is cloud in the way, because that
        // is where the climb ends whatever the air is doing above it.
        const usable = top !== null && lift !== null
            ? climbTop(top, surface.elevation, lift)
            : null;

        const climbCeiling = usable !== null && base !== null
            ? Math.min(usable, base)
            : usable;

        const rain = aggregated.map(station => station[i].precipRate).filter(isNumber);
        const pressure = pressures && isNumber(pressures[i].pressure) ? pressures[i].pressure : null;

        columns.push({
            time,
            levels,
            profile,
            segments,
            above,
            thermalTop: top,
            climbTop: climbCeiling,
            cloudBase: base !== null && base < ceiling ? base : null,
            shade,
            cloud: sounding.cloudAt(modelled, time),
            lift,
            pressure,
            rain: rain.length ? Math.max(...rain) : null,
            clouds: levels.length ? cloudBands(levels, floor, levels.at(-1).elevation) : []
        });
    }

    // The three lines that are crossings rather than readings, taken down the
    // same way the forecast takes them and the RASP takes its own. Between two
    // half-hourly columns the stations can disagree by a tenth of a degree,
    // which is nothing as a temperature and several hundred metres as a thermal
    // top — so the raw lines whipped up and down across a settled afternoon.
    ['thermalTop', 'climbTop', 'cloudBase'].forEach(field => {
        const smoothed = binomial(columns.map(column => column[field]));
        columns.forEach((column, index) => { column[field] = smoothed[index]; });
    });

    // Cloudbase still ends the climb, whatever smoothing did to the pair.
    columns.forEach(column => {
        if (column.climbTop === null || column.cloudBase === null) return;

        column.climbTop = Math.min(column.climbTop, column.cloudBase);
    });

    return {
        dayStart,
        lastTime,
        floor,
        ground,
        ceiling,
        // The station's own clock, so the hours along the bottom read as the
        // hours a pilot would be flying rather than as UTC.
        offset: charted[0].day.offset,
        launch: {...launch.station, elevation: launchElevation},
        stations: charted.map(entry => ({
            ...entry.station,
            elevation: entry.elevationFeet * FEET,
            elevationFeet: entry.elevationFeet
        })),
        latitude,
        longitude,
        // Whether the air above the top station came from the model or from
        // continuing the last measured gradient. The footnotes say which, since
        // the two deserve different amounts of trust.
        modelledAloft: columns.some(column => column.segments.some(segment => segment.extrapolated)),
        columns,
        isotherms: isotherms(columns, ceiling)
    };
}

/**
 * The temperature contours across the drawing.
 *
 * One polyline per five degrees, each tracing the height at which the air is
 * that temperature. They break wherever a column cannot answer, so a gap in the
 * readings leaves a gap in the contour rather than a line ruled across it.
 *
 * @param {Object[]} columns - The built columns
 * @param {number} ceiling - The top of the drawing, in metres
 * @returns {Object[]} One {value, runs} per contour
 */
export function isotherms(columns, ceiling) {
    const temps = columns.flatMap(column => (column.profile ?? column.levels).map(level => level.temp));
    if (temps.length < 2) return [];

    // The contours have to cover the extrapolated air too, which is colder than
    // anything measured, so the range is taken from the top of the drawing
    // rather than from the readings alone.
    const coldest = Math.min(...columns.map(column => {
        const level = (column.profile ?? column.levels).at(-1);
        const above = column.above;
        if (!level || !above) return level?.temp ?? Infinity;

        // The rate is per 1000 ft and negative when cooling with height.
        return level.temp + above.rate * ((ceiling - level.elevation) / FEET) / 1000;
    }).filter(Number.isFinite));

    const low = Math.ceil(Math.min(coldest, Math.min(...temps)) / ISOTHERM_STEP) * ISOTHERM_STEP;
    const high = Math.floor(Math.max(...temps) / ISOTHERM_STEP) * ISOTHERM_STEP;

    const lines = [];

    for (let value = low; value <= high; value += ISOTHERM_STEP) {
        const runs = [];
        let run = [];

        columns.forEach(column => {
            const height = heightAtTemperature(column.profile ?? column.levels, value, ceiling);

            if (height === null) {
                if (run.length > 1) runs.push(run);
                run = [];
                return;
            }

            run.push({time: column.time, elevation: height});
        });

        if (run.length > 1) runs.push(run);
        if (runs.length) lines.push({value, runs});
    }

    return lines;
}
