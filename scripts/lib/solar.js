/**
 * Where the sun is, and how much of it is getting through.
 *
 * None of the stations carries a cloud sensor, but every one of them carries a
 * pyranometer. That is enough to say how much sunlight is going missing: work
 * out how much *should* be reaching the ground at this latitude and this
 * moment, compare it with what actually arrived, and the shortfall is the
 * answer. The same clear-sky figure is what the thermal calculation needs for
 * surface heating, so both come out of this one module.
 *
 * What that shortfall is deliberately *not* called is cloud. There is a
 * standard inversion — Kasten–Czeplak — that turns a clearness ratio into an
 * okta count, and it was the first thing tried here. It is far too steep near a
 * clear sky to survive this input: it read a genuine 0.96 clearness as 43%
 * cloud, so a few percent of error in the clear-sky model became tens of
 * percent of imaginary cloud. It also cannot tell cloud from the ridge east of
 * launch, which shades the sensor every morning.
 *
 * So the number reported is the shortfall itself, and it is named for what it
 * is: shade. Cloud, haze and terrain all count, which is honest, because the
 * instrument cannot separate them.
 */

// The solar constant, in W/m². The atmosphere takes a large bite out of this
// before any of it reaches a sensor; that is what the clear-sky model is for.
const SOLAR_CONSTANT = 1361;

// Below this the sun is on or under the horizon, and a pyranometer reading
// carries no information about cloud: a black night and a solid overcast look
// identical to it.
const MINIMUM_ELEVATION = 0.05;

/**
 * Below this much clear-sky irradiance, the shortfall cannot be read honestly.
 *
 * The method divides by the clear-sky figure, so as the sun goes down the
 * divisor heads for zero and the answer heads for meaningless. Refusing to
 * answer at dawn and dusk is a better chart than answering wrongly.
 */
const MINIMUM_CLEAR_SKY = 120;

const RADIANS = Math.PI / 180;

/**
 * How high the sun sits, as the cosine of its zenith angle.
 *
 * Zero at the horizon and one directly overhead, which is exactly the factor a
 * flat sensor sees, so it can be used as-is rather than converted to an angle
 * and back.
 *
 * Solar time is taken from longitude rather than from the station's clock,
 * because a station's clock is a timezone and a timezone is a political
 * boundary: Vernon is nearly half an hour off its own solar noon.
 *
 * @param {number} time - The moment, in milliseconds
 * @param {number} latitude - Degrees north
 * @param {number} longitude - Degrees east, so negative through the Americas
 * @returns {number} cos(zenith), clamped at zero when the sun is down
 */
export function sunHeight(time, latitude, longitude) {
    const date = new Date(time);
    const start = Date.UTC(date.getUTCFullYear(), 0, 1);
    const day = Math.floor((time - start) / 86400000) + 1;

    // Declination: how far north or south the sun has wandered this month.
    const declination = 23.45 * Math.sin(RADIANS * 360 * (284 + day) / 365);

    // The equation of time — the earth's orbit is neither circular nor upright,
    // so true solar noon drifts by up to a quarter of an hour across the year.
    const angle = RADIANS * 360 * (day - 81) / 364;
    const equation = 9.87 * Math.sin(2 * angle) - 7.53 * Math.cos(angle) - 1.5 * Math.sin(angle);

    const utcHours = (time - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
        / 3600000;
    const solarHours = utcHours + longitude / 15 + equation / 60;

    // Fifteen degrees an hour, measured from noon.
    const hourAngle = RADIANS * 15 * (solarHours - 12);

    const height = Math.sin(RADIANS * latitude) * Math.sin(RADIANS * declination)
        + Math.cos(RADIANS * latitude) * Math.cos(RADIANS * declination) * Math.cos(hourAngle);

    return Math.max(0, height);
}

/**
 * What a pyranometer would read under a clear sky.
 *
 * Haurwitz's model: simple, needs nothing but the sun's height, and is within a
 * few percent of far heavier models for the purpose here. The eccentricity of
 * the orbit is folded in because it is nearly free and it is worth 3% between
 * January and July.
 *
 * @param {number} height - cos(zenith), from sunHeight
 * @param {number} time - The moment, in milliseconds
 * @returns {number} Global horizontal irradiance, in W/m²
 */
export function clearSky(height, time) {
    if (height <= MINIMUM_ELEVATION) return 0;

    const date = new Date(time);
    const day = Math.floor((time - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000) + 1;
    const eccentricity = 1 + 0.033 * Math.cos(RADIANS * 360 * day / 365);

    return Math.min(
        1098 * height * Math.exp(-0.059 / height) * eccentricity,
        SOLAR_CONSTANT * height
    );
}

/**
 * How much of the available sunlight is not getting through.
 *
 * Returns null rather than zero when the sun is too low to tell, because "clear
 * sky" and "no evidence" are different answers and only one of them should be
 * drawn.
 *
 * @param {?number} measured - What the station's pyranometer read, in W/m²
 * @param {number} clear - What a clear sky would have given, in W/m²
 * @returns {?number} Shade from 0 to 1, or null when it cannot be told
 */
export function shadeFraction(measured, clear) {
    if (measured === null || measured === undefined || !Number.isFinite(measured)) return null;
    if (clear < MINIMUM_CLEAR_SKY) return null;

    // A sensor reading over its own clear-sky figure is not a negative cloud:
    // it is cloud edge scatter, a model a few percent low, or a station a
    // kilometre higher than the model assumes. All of them mean "clear".
    const clearness = Math.min(1, measured / clear);

    return Math.min(1, Math.max(0, 1 - clearness));
}
