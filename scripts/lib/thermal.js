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

// Standard atmosphere, for working out the pressure at a height when no
// barometer reports one. Two of the three stations have no barometer, and the
// two that do disagree about whether they mean station or sea-level pressure,
// so a table is more trustworthy here than a sensor.
const SEA_LEVEL_PRESSURE = 101325;
const GAS_CONSTANT = 287.05;

// 0.61 × cp / Lv, with cp 1006 J/kg/K and Lv 2.502 MJ/kg. Multiplied by the
// surface temperature in kelvin it turns a latent heat flux into the sensible
// one it is worth for buoyancy — around seven percent of it. The same figure
// the Canadian RASP uses, and the one `sounding.js` carries pre-multiplied as
// LATENT_SHARE for the one place it has no temperature to multiply by.
const VIRTUAL_LATENT = 0.000245268;

// R/cp, the exponent in Poisson's equation. The RASP's own figure, from the
// molar values 8.314 / 29.19 J/mol/K. The textbook dry-air 2/7 = 0.28571 is
// three parts in a thousand away from it and would move a climb rate by well
// under a hundredth of a metre per second; this is here to match rather than
// because the difference could be seen.
const KAPPA = 0.28482;

/**
 * The fallback share of sunlight that comes back as heat in the air rather than
 * going into evaporation, soil, or straight back out as reflection.
 *
 * Only used when nothing better is available. A model that carries its own
 * surface energy balance knows this split for the day in question — whether the
 * ground is wet, what is growing on it, how long since it rained — and that
 * varies far more than a single constant can express. Forested mountain terrain
 * sits near the bottom of the usual range, which is where this sits.
 */
export const HEAT_FRACTION = 0.2;

/**
 * How fast a glider sinks through still air, in metres per second.
 *
 * Not a property of the weather at all: it is what turns "the air here is going
 * up at this rate" into "a wing here would climb", which is the question a pilot
 * is actually asking. One metre per second is what the Canadian RASP uses, and
 * keeping the same figure is what lets its climb height and this one be read as
 * the same number.
 */
export const GLIDER_SINK = 1.0;

/**
 * How far a parcel rises before it reaches its dew point, per degree of spread
 * between temperature and dew point at the surface.
 *
 * The standard field approximation. 121 metres rather than the textbook 125 is
 * the Canadian RASP's own figure, and matching it is what lets its cloud base
 * and this one be read as the same number.
 */
export const LCL_PER_DEGREE = 121;

/**
 * The shape of the climb through the convective layer.
 *
 * A thermal is not one speed all the way up: it accelerates off the deck, peaks
 * around a third of the way up, and dies out below the top of the layer. The
 * peak multiplies the layer mean; the taper is how fast it falls away above.
 *
 * Both are the RASP's, and the pair of them decide where a climb ends. With
 * this taper the best climb in the layer is 2.04 times the layer mean, a third
 * of the way up — which is why a day can have a healthy mean climb rate and
 * still be unflyable, and why the two are drawn as separate things.
 */
export const UPDRAFT_PEAK = 4;
export const UPDRAFT_TAPER = 0.8;

/**
 * Air pressure at a height, from the standard atmosphere.
 * @param {number} elevation - Metres above sea level
 * @returns {number} Pressure in pascals
 */
export function pressureAt(elevation) {
    return SEA_LEVEL_PRESSURE * Math.pow(1 - 2.25577e-5 * elevation, 5.25588);
}

/**
 * How dense the air is where the thermal starts.
 *
 * Worth computing rather than assuming: a thermal at Cooper's leaves the ground
 * three and a half thousand feet up, where the air is nearly a tenth thinner
 * than the sea-level figure a constant would carry.
 *
 * @param {number} elevation - Metres above sea level
 * @param {number} temp - Air temperature in ºC
 * @param {?number} [pressure] - Measured or modelled pressure in pascals, when known
 * @returns {number} Density in kg/m³
 */
export function airDensity(elevation, temp, pressure = null) {
    const measured = pressure === null ? pressureAt(elevation) : pressure;

    return measured / (GAS_CONSTANT * (temp + 273.15));
}

/**
 * Potential temperature: what this air would be if brought to 1000 mb.
 *
 * The buoyancy term wants the temperature of the air as a body rather than as
 * read on a thermometer partway up a mountain, which is what this converts it
 * to. Small — three percent at launch height — but free once the pressure is
 * known.
 *
 * @param {number} elevation - Metres above sea level
 * @param {number} temp - Air temperature in ºC
 * @param {?number} [pressure] - Measured or modelled pressure in pascals, when known
 * @returns {number} Potential temperature in kelvin
 */
export function potentialTemperature(elevation, temp, pressure = null) {
    const measured = pressure === null ? pressureAt(elevation) : pressure;

    return (temp + 273.15) * Math.pow(100000 / measured, KAPPA);
}

/**
 * The dew point, from the temperature and the relative humidity.
 *
 * The Magnus form, which is what every weather service uses and is good to a
 * tenth of a degree over the range a windgram covers. Needed because a model
 * publishes humidity aloft as a percentage, while every other part of this
 * calculation wants the temperature the air would have to reach to saturate.
 *
 * @param {number} temp - Air temperature in ºC
 * @param {number} humidity - Relative humidity in percent
 * @returns {?number} Dew point in ºC, or null when the humidity is unusable
 */
export function dewpoint(temp, humidity) {
    if (!(humidity > 0)) return null;

    const bounded = Math.min(100, humidity);
    const gamma = Math.log(bounded / 100) + 17.625 * temp / (243.04 + temp);

    return 243.04 * gamma / (17.625 - gamma);
}

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

    // Bounded by the profile as well as by the drawing. Past the topmost level
    // the environment is extrapolated from the gradient below it, and a parcel
    // raced against a straight line will win for as long as the line is drawn —
    // so a search that ran to the ceiling was really measuring the ceiling.
    // That mattered doubly once the ceiling came to be built from these tops:
    // the chart would have been answering its own question. The RASP scans the
    // levels it has and no further, and so does this.
    const limit = Math.min(ceiling, levels.at(-1).elevation);

    let previous = ground;

    for (let height = ground + step; height <= limit; height += step) {
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

    // Still buoyant at the top of the profile. The honest answer is "at least
    // this high" rather than a height nothing was measured at.
    return limit - ground < MINIMUM_DEPTH ? null : limit;
}

/**
 * How deep the convective layer is, off a modelled sounding.
 *
 * The same parcel argument as `thermalTop`, but solved rather than walked, and
 * with no trigger offset. Both differences come from the profile: a model
 * publishes a dozen levels with the surface temperature among them, so the
 * crossing can be found exactly inside whichever pair of levels straddles it,
 * and the surface reading is the model's own ground temperature rather than a
 * thermometer standing in the parcel's own air — so there is nothing to
 * correct for.
 *
 * Returned as a depth rather than a height because that is what the climb rate
 * is scaled by. This is the Canadian RASP's calculation, constant for constant.
 *
 * @param {number} surfaceTemp - Ground-level air temperature in ºC
 * @param {Object[]} levels - Ascending {elevation, temp} strictly above the ground
 * @param {number} ground - Where the parcel starts, in metres above sea level
 * @returns {number} Depth in metres above ground, or zero when nothing rises
 */
export function blDepth(surfaceTemp, levels, ground) {
    let below = {elevation: ground, temp: surfaceTemp};

    for (const level of levels) {
        if (level.elevation <= ground) continue;

        // Still the warmer of the two, so the parcel carries on past this level.
        if (surfaceTemp - DRY_ADIABAT * (level.elevation - ground) > level.temp) {
            below = level;
            continue;
        }

        // Inside this pair the environment is taken to change linearly, so the
        // height where the two curves meet can be solved outright.
        const gradient = (level.temp - below.temp) / (level.elevation - below.elevation);
        const closing = DRY_ADIABAT + gradient;

        // The two curves are parallel, or the layer is steeper than the parcel
        // cools — neither of which crosses anywhere inside this pair.
        if (!(closing > 0)) return 0;

        const depth = (surfaceTemp - below.temp + gradient * (below.elevation - ground)) / closing;

        return depth > 0 ? depth : 0;
    }

    return 0;
}

/**
 * The heat that actually drives buoyancy.
 *
 * Warming the air is most of it, but not all: heat that goes into evaporating
 * water still lifts the parcel, because water vapour is lighter than the air it
 * displaces. The coefficient is 0.61 × cp / Lv, which turns a latent flux into
 * the sensible one it is worth in buoyancy terms.
 *
 * @param {number} sensible - Sensible heat flux in W/m²
 * @param {number} latent - Latent heat flux in W/m²
 * @param {number} temp - Surface temperature in ºC
 * @returns {number} The virtual heat flux in W/m²
 */
export function virtualHeatFlux(sensible, latent, temp) {
    return sensible + VIRTUAL_LATENT * (temp + 273.15) * latent;
}

/**
 * How fast the air in a thermal is going up, on average.
 *
 * Deardorff's convective velocity scale: the standard way of turning "this much
 * heat, spread through this deep a layer" into a speed. It is the mean over the
 * whole boundary layer, so the core of a good thermal will beat it and the sink
 * between them will not — which is the right number for a strip on a chart.
 *
 * Takes the heat actually going into the air rather than the sunlight landing on
 * the ground, because how much of the one becomes the other is a property of the
 * day and not a constant. `heatFlux` below turns one into the other.
 *
 * One deliberate departure from the RASP, which folds the density into its
 * constant at a sea-level 1.29 kg/m³. Here it is computed, because a thermal at
 * Cooper's leaves the ground three and a half thousand feet up, where the air is
 * nearly a fifth thinner than that — worth about seven percent on the climb
 * rate, and free once the pressure is known. The formula is otherwise identical.
 *
 * @param {number} depth - Depth of the convective layer, in metres
 * @param {number} flux - Heat entering the air, in W/m²
 * @param {number} temp - Surface temperature, in ºC
 * @param {number} [elevation=0] - Height of that surface, in metres
 * @param {?number} [pressure] - Surface pressure in pascals, when the model reports one
 * @returns {number} Metres per second
 */
export function updraft(depth, flux, temp, elevation = 0, pressure = null) {
    if (!(depth > 0) || !(flux > 0)) return 0;

    const density = airDensity(elevation, temp, pressure);
    const theta = potentialTemperature(elevation, temp, pressure);

    return Math.cbrt((GRAVITY / theta) * (flux / (density * SPECIFIC_HEAT)) * depth);
}

/**
 * The heat going into the air, from the sunlight landing on the ground.
 *
 * The share is the part worth getting from somewhere better than a constant:
 * on dry ground almost all of it heats the air, and on wet ground most of it
 * goes into evaporating water and never drives a thermal at all. The sunlight
 * itself should always be the measured one — a pyranometer at launch knows
 * about today's smoke and today's cirrus, and a model an hour old does not.
 *
 * @param {number} irradiance - Sunlight reaching the ground, in W/m²
 * @param {?number} [share] - The fraction that becomes heat, when it is known
 * @returns {?number} Heat flux in W/m², or null without sunlight to convert
 */
export function heatFlux(irradiance, share = null) {
    if (!(irradiance > 0)) return null;

    const fraction = share === null ? HEAT_FRACTION : share;

    return fraction * irradiance;
}

/**
 * How high a glider can still climb.
 *
 * A thermal is not one speed all the way up. It accelerates off the deck, peaks
 * around a quarter of the way up the layer, and dies out below the top — so the
 * height where the air stops going up faster than a wing goes down is well
 * beneath the height where the bubble finally runs out of buoyancy. That lower
 * height is the one worth flying to, and it is what the RASP calls hcrit.
 *
 * The profile is the RASP's own: four times the layer mean, shaped by the cube
 * root of the height fraction and falling away linearly above it, which puts
 * peak climb at about twice the mean and zero at the top of the layer.
 *
 * @param {number} top - Top of the convective layer, in metres above sea level
 * @param {number} ground - Where the thermal starts, in metres above sea level
 * @param {number} wstar - The layer's mean climb rate, in m/s
 * @param {Object} [options] - sink rate in m/s, and the height tolerance
 * @returns {?number} Metres above sea level, or null when nothing climbs
 */
export function climbTop(top, ground, wstar, {sink = GLIDER_SINK, tolerance = 10} = {}) {
    const depth = top - ground;

    // The same floor the buoyancy calculation uses: a layer this shallow is
    // noise between two thermometers rather than a thermal.
    if (!(depth > MINIMUM_DEPTH) || !(wstar > 0)) return null;

    const climb = height =>
        wstar * UPDRAFT_PEAK * Math.cbrt(height / depth) * (1 - UPDRAFT_TAPER * (height / depth));

    // Searched above the peak, so the answer is the top of the usable climb
    // rather than the point on the way up where it first got good.
    let low = 0.25 * depth;
    let high = depth;

    // Never beats the wing, even at its best. There is no height to report.
    if (climb(low) <= sink) return null;

    while (high - low > tolerance) {
        const middle = (low + high) / 2;
        if (climb(middle) > sink) low = middle; else high = middle;
    }

    return ground + low;
}
