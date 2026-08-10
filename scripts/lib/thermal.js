/**
 * How high a thermal gets, and how fast it climbs.
 *
 * This is the one part of the windgram that is genuinely a forecast rather than
 * a reading, and it is worth being explicit about the method because it is the
 * same one a pilot does by hand on a sounding.
 *
 * A bubble of surface air that breaks away cools as it rises, at very close to
 * 9.8 ºC per kilometre, because it expands against falling pressure and no heat
 * enters or leaves it. The air around it cools at whatever rate the stations
 * actually measured. As long as the bubble stays warmer than its surroundings
 * it is buoyant and keeps going; the height where the two curves meet is the
 * top of the lift. That height is the single number every other thermal figure
 * is built from.
 *
 * The honest caveat: a real sounding has dozens of levels, and this has three.
 * Above the highest station the profile is continued at the rate measured
 * between the top two, which is a guess, and the drawing marks it as one.
 */

// The dry adiabatic lapse rate, in ºC per metre. Not a measurement and not a
// tuning constant — it falls out of the gas laws.
export const DRY_ADIABAT = 0.0098;

const GRAVITY = 9.81;
const SPECIFIC_HEAT = 1005;
const AIR_DENSITY = 1.1;

// The share of the sunlight landing on the ground that comes back as heat in
// the air rather than going into evaporation, soil, or straight back out as
// reflection. Forested mountain terrain sits near the bottom of the usual
// range; this is the one number here a local pilot might reasonably retune.
export const HEAT_FRACTION = 0.2;

// A bubble that never gets more than this far off the deck is not a thermal,
// it is measurement noise between two stations.
const MINIMUM_DEPTH = 50;

/**
 * How much warmer than the air around it a bubble has to be before it goes.
 *
 * Without this the calculation answers "never": the air a thermometer sits in
 * is the same air the parcel starts as, so the parcel is neutrally buoyant by
 * definition and stops at the first step. What actually launches a thermal is
 * the shallow superadiabatic layer right at the ground, which is hotter than
 * the screen-height reading and is not measured by anything we have.
 *
 * Two and a half degrees is the usual allowance, and it is what the thermal
 * index method assumes when it is done by hand off a sounding. It is the single
 * most consequential number in this file: raise it and every thermal gets
 * higher.
 */
export const TRIGGER_OFFSET = 2.5;

/**
 * The temperature of the air at a height, read off the measured profile.
 *
 * Between two stations the temperature is taken to change linearly, which over
 * a few hundred metres is the same assumption the lapse rate itself makes.
 * Below the lowest station and above the highest, the nearest measured gradient
 * is continued — flagged, so the caller can draw that part differently.
 *
 * @param {Object[]} levels - Ascending {elevation, temp}, elevation in metres
 * @param {number} height - The height to read, in metres
 * @returns {?Object} temp and whether it was extrapolated, or null with no levels
 */
export function temperatureAt(levels, height) {
    if (!levels.length) return null;
    if (levels.length === 1) return {temp: levels[0].temp, extrapolated: height !== levels[0].elevation};

    // Inside the measured column: find the pair that straddles this height.
    for (let i = 0; i < levels.length - 1; i++) {
        const below = levels[i];
        const above = levels[i + 1];

        if (height >= below.elevation && height <= above.elevation) {
            const fraction = (height - below.elevation) / (above.elevation - below.elevation);
            return {temp: below.temp + fraction * (above.temp - below.temp), extrapolated: false};
        }
    }

    const [first, second] = height < levels[0].elevation
        ? [levels[0], levels[1]]
        : [levels.at(-1), levels.at(-2)];

    const gradient = (first.temp - second.temp) / (first.elevation - second.elevation);

    return {temp: first.temp + gradient * (height - first.elevation), extrapolated: true};
}

/**
 * The height where a surface bubble runs out of buoyancy.
 *
 * Walked upward in steps rather than solved, because the profile is piecewise
 * and the parcel can cross back and forth through an inversion before it
 * finally stops. The first crossing is the answer: a bubble that stalls at
 * 800 metres does not care that the air above 2000 would have carried it.
 *
 * @param {Object[]} levels - Ascending {elevation, temp}, elevation in metres
 * @param {number} ceiling - How high to bother looking, in metres
 * @param {Object} [options] - trigger offset in ºC, and the step of the walk
 * @returns {?number} The top of the lift in metres above sea level, or null
 */
export function thermalTop(levels, ceiling, {trigger = TRIGGER_OFFSET, step = 25} = {}) {
    if (levels.length < 2) return null;

    const ground = levels[0].elevation;
    const surface = levels[0].temp + trigger;

    let previous = ground;

    for (let height = ground + step; height <= ceiling; height += step) {
        const parcel = surface - DRY_ADIABAT * (height - ground);
        const environment = temperatureAt(levels, height);

        if (!environment) return null;

        // The moment the bubble is no longer the warmer of the two, it stops.
        // The depth tested is the one about to be returned, not the step that
        // failed: measuring the failed step reported a twenty-five metre bubble
        // under a hard inversion as a five-hundred-metre thermal top.
        if (parcel <= environment.temp) {
            return previous - ground < MINIMUM_DEPTH ? null : previous;
        }

        previous = height;
    }

    // Buoyant the whole way up. The ceiling is as much as this drawing knows.
    return ceiling;
}

/**
 * How fast the air in a thermal is going up, on average.
 *
 * Deardorff's convective velocity scale: the standard way of turning "this much
 * heat, spread through this deep a layer" into a speed. It is the mean over the
 * whole boundary layer, so the core of a good thermal will beat it and the sink
 * between them will not — which is the right number for a strip on a chart.
 *
 * @param {number} depth - Depth of the convective layer, in metres
 * @param {number} irradiance - Sunlight reaching the ground, in W/m²
 * @param {number} temp - Surface temperature, in ºC
 * @returns {number} Metres per second
 */
export function updraft(depth, irradiance, temp) {
    if (!(depth > 0) || !(irradiance > 0)) return 0;

    const flux = HEAT_FRACTION * irradiance;
    const kelvin = temp + 273.15;

    return Math.cbrt((GRAVITY / kelvin) * (flux / (AIR_DENSITY * SPECIFIC_HEAT)) * depth);
}
