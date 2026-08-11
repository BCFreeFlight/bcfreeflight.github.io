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
 * The honest caveat: a real sounding has dozens of levels and the hillside has
 * three thermometers. The gaps between them are filled with the shape of the
 * HRDPS model, moved onto each station's own reading so that the measurements
 * are never overwritten — see `anchored` in `rasp.js`. Above the highest
 * station there is nothing left to anchor to and the drawing says so, in its
 * footnotes and by knocking that air back.
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
 * around a quarter of the way up, and dies out below the top of the layer. The
 * peak multiplies the layer mean; the taper is how fast it falls away above.
 *
 * Both are the RASP's — `get-hcrit` in `generate-new-variables.lisp`, which
 * writes the profile as `wstar × 4 × (agl/bldepth)^⅓ × (1 − 1.1 × agl/bldepth)`.
 * The 1.1 is deliberate on its author's part: the file opens by noting the
 * shape was switched back to 1.1 from 0.8. We had the 0.8, which put the climb
 * dying at the top of the layer rather than at nine tenths of it and made every
 * climb height too generous.
 *
 * With the RASP's taper the best climb in the layer is 1.83 times the layer
 * mean, 23% of the way up, and the air stops beating a wing well below the top
 * — which is why a day can have a healthy mean climb rate and still be
 * unflyable, and why the two are drawn as separate things.
 */
export const UPDRAFT_PEAK = 4;
export const UPDRAFT_TAPER = 1.1;

/**
 * Air pressure at a height, from the standard atmosphere.
 * @param {number} elevation - Metres above sea level
 * @returns {number} Pressure in pascals
 */
export function pressureAt(elevation) {
    return SEA_LEVEL_PRESSURE * Math.pow(1 - 2.25577e-5 * elevation, 5.25588);
}

/**
 * Air pressure at a height, off the model's own pressure levels.
 *
 * The RASP reads a surface pressure field and uses it directly; the measured
 * drawing has no such field, because two of the three stations have no
 * barometer and the two that do disagree about whether they mean station or
 * sea-level pressure. But the sounding is a list of heights each labelled with
 * the pressure it is at, which answers the same question for any height between
 * them — and it is the same HRDPS field the RASP would have read.
 *
 * Interpolated in log pressure, which is what makes it a straight line: pressure
 * falls exponentially with height, so the logarithm of it does not.
 *
 * @param {Object[]} levels - Ascending levels carrying pressure in hPa
 * @param {number} elevation - Metres above sea level
 * @returns {?number} Pressure in pascals, or null when no level says
 */
export function pressureFrom(levels, elevation) {
    const known = levels
        .filter(level => Number.isFinite(level.pressure) && Number.isFinite(level.elevation))
        .sort((a, b) => a.elevation - b.elevation);

    if (known.length < 2) return null;

    // The pair that straddles the height, or the nearest pair to continue from
    // when it sits outside them altogether.
    let below = known[0];
    let above = known[1];

    for (let i = 0; i < known.length - 1; i++) {
        if (elevation > known[i + 1].elevation && i + 2 < known.length) continue;

        below = known[i];
        above = known[i + 1];
        break;
    }

    const share = (elevation - below.elevation) / (above.elevation - below.elevation);
    const logged = Math.log(below.pressure) + share * (Math.log(above.pressure) - Math.log(below.pressure));

    return Math.exp(logged) * 100;
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

/**
 * How deep the convective layer has to be before a climb height is worked out
 * at all, in metres above the ground.
 *
 * The RASP's own gate: `get-hcrit` reports the terrain height itself for
 * anything under a hundred metres AGL rather than searching a layer that
 * shallow. Below it there is nothing a wing could use anyway, and the search
 * would be bisecting a layer thinner than its own tolerance.
 */
const MINIMUM_DEPTH = 100;

/**
 * How much warmer than the air around it a bubble has to be before it goes.
 *
 * Without this the calculation answers "never": the air a thermometer sits in
 * is the same air the parcel starts as, so the parcel is neutrally buoyant by
 * definition and stops at the first step. What actually launches a thermal is
 * the shallow superadiabatic layer right at the ground, which is hotter than
 * the screen-height reading and is not measured by anything we have.
 *
 * The Canadian RASP needs no such allowance, and it is worth being clear about
 * why rather than treating this as a free parameter. Its parcel also starts
 * from a 2 m temperature — but its next reading up is a pressure level a few
 * hundred metres above the ground, and the model resolves the superadiabatic
 * layer in between. The parcel is genuinely buoyant on the model's own numbers.
 * Here the lowest level *is* the thermometer, so that layer is invisible and
 * has to be allowed for.
 *
 * Two and a half degrees is the usual allowance, and it is what the thermal
 * index method assumes when it is done by hand off a sounding. It is the single
 * most consequential number in this file: raise it and every thermal gets
 * higher.
 */
export const TRIGGER_OFFSET = 2.5;

/**
 * The sunlight at which the ground is heating hard enough to earn the whole
 * allowance above, in W/m².
 *
 * The superadiabatic layer is made by the sun, so the allowance for it cannot
 * be a constant across the day: applied flat, it punched the same two and a
 * half degrees into the profile at first light as at two in the afternoon, and
 * the drawing claimed thermals well before there was anything driving them.
 *
 * Seven hundred is roughly the point past which more sunshine stops making the
 * surface layer meaningfully deeper. Below it the allowance is scaled down in
 * proportion. This is a heuristic — unlike everything else in this file it is
 * not from the RASP, which has no equivalent because it does not need one.
 */
export const FULL_SUN = 700;

/**
 * The allowance to lift a parcel with, for the sunlight actually measured.
 * @param {?number} irradiance - Sunlight reaching the ground, in W/m²
 * @returns {number} Degrees to add to the surface temperature
 */
export function triggerFor(irradiance) {
    if (!(irradiance > 0)) return 0;

    return TRIGGER_OFFSET * Math.min(1, irradiance / FULL_SUN);
}

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
 * How deep the convective layer is, off any profile.
 *
 * The Canadian RASP's `get-boundary-layer-depth`, which is the parcel method a
 * pilot does by hand: a bubble of surface air cools at the dry adiabatic rate
 * as it rises, the air around it cools at whatever the sounding says, and the
 * first height where the parcel is no longer the warmer of the two is the top
 * of the layer. Inside the pair of levels that straddles that crossing the
 * environment is taken to change linearly, so the height is solved outright
 * rather than searched for.
 *
 * One function rather than two. The measured drawing used to walk the profile
 * in 25 m steps while the forecast solved the crossing analytically, which
 * meant the two answered the same question with different arithmetic — a
 * difference nobody could account for when the tabs disagreed. What genuinely
 * differs between them is what goes *in*: where the parcel is released, what
 * temperature it starts at, and whether it needs the trigger offset below.
 *
 * @param {Object[]} levels - Ascending {elevation, temp}, in metres and ºC
 * @param {Object} options - release height, its temperature, trigger and ceiling
 * @returns {?number} Depth above the release in metres, zero when nothing
 *     rises, or null when the profile cannot answer at all
 */
export function convectiveDepth(levels, {release, surfaceTemp, trigger = 0, ceiling = Infinity} = {}) {
    if (!Number.isFinite(release) || !Number.isFinite(surfaceTemp)) return null;

    const above = levels.filter(level =>
        level.elevation > release && Number.isFinite(level.temp));

    if (!above.length) return null;

    // The parcel leaves the ground warmer than the reading by the trigger
    // offset — which is zero for a modelled column, where the surface
    // temperature is the ground's own and the superadiabatic layer is resolved.
    const parcel = surfaceTemp + trigger;

    // Bounded by the profile as well as by the drawing. Past the topmost level
    // the environment would have to be extrapolated, and a parcel raced against
    // a straight line wins for as long as the line is drawn — so a search that
    // ran to the ceiling was really measuring the ceiling. That mattered doubly
    // once the ceiling came to be built from these depths: the chart would have
    // been answering its own question.
    const limit = Math.min(ceiling, above.at(-1).elevation);

    let below = {elevation: release, temp: surfaceTemp};

    for (const level of above) {
        if (level.elevation > limit) break;

        // Still the warmer of the two, so the bubble carries on past this level.
        if (parcel - DRY_ADIABAT * (level.elevation - release) > level.temp) {
            below = level;
            continue;
        }

        const gradient = (level.temp - below.temp) / (level.elevation - below.elevation);
        const closing = DRY_ADIABAT + gradient;

        // The two curves are parallel, or the layer cools faster than the
        // parcel does — neither of which crosses anywhere inside this pair.
        if (!(closing > 0)) return 0;

        const depth = (parcel - below.temp + gradient * (below.elevation - release)) / closing;

        return depth > 0 ? Math.min(depth, limit - release) : 0;
    }

    // Still buoyant at the top of what there is to read. The honest answer is
    // "at least this deep" rather than a height nothing was measured at.
    return Math.max(0, limit - release);
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

/**
 * Everything a pilot reads off the layer, from its depth.
 *
 * The three figures at the top of a windgram — where the lift stops, how fast
 * it goes up, and how high a wing still climbs — are all the same calculation
 * downstream of the boundary layer depth, and the RASP treats them that way:
 * `wstar` from the depth, `hcrit` from `wstar`, and the cloud base capping the
 * result. Both drawings on this site now derive them here, from whatever depth
 * they worked out and whatever heat they have, so that a disagreement between
 * the measured day and the forecast can only ever be about their inputs.
 *
 * Called after the depth has been smoothed rather than before, because these
 * are crossings: a tenth of a degree of wobble in a profile steps the depth by
 * hundreds of metres, and three figures smoothed separately do not keep the
 * order between them — the climb line drifts above the cloud base it is
 * supposed to stop at.
 *
 * @param {?number} depth - The convective layer's depth above the release
 * @param {Object} options - release, surfaceTemp, flux, pressure and cloudBase
 * @returns {Object} thermalTop, lift and climbTop, in metres and m/s
 */
export function climbFrom(depth, {release, surfaceTemp, flux, pressure = null, cloudBase = null} = {}) {
    const nothing = {thermalTop: null, lift: null, climbTop: null};

    // A gap rather than a zero: the hour was never answered, and a strip drawn
    // through it would be inventing one.
    if (depth === null || depth === undefined || flux === null || flux === undefined) return nothing;
    if (!Number.isFinite(release) || !Number.isFinite(surfaceTemp)) return nothing;

    const rising = flux > 0 && depth > 0;

    // Nothing going up is a reading of zero, not a gap — an evening with the
    // ground already cooling is an answer.
    const lift = rising ? updraft(depth, flux, surfaceTemp, release, pressure) : 0;
    const top = rising ? release + depth : null;

    const usable = top !== null && lift ? climbTop(top, release, lift) : null;

    // Cloud base ends the climb whatever the air above it is doing, which is
    // what the RASP's `min(hcrit, lcl)` says too.
    return {
        thermalTop: top,
        lift,
        climbTop: usable !== null && cloudBase !== null ? Math.min(usable, cloudBase) : usable
    };
}
