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
 * Where the sun is in its year, for a given moment.
 *
 * Pulled out so that the height of the sun and the time it crosses the horizon
 * are worked out from the same declination and the same equation of time. Two
 * copies of this arithmetic would drift apart, and the drawing would shade a
 * night that started at a different moment from the one its markers named.
 *
 * @param {number} time - The moment, in milliseconds
 * @returns {Object} declination and equation, in degrees and minutes
 */
function solarYear(time) {
    const start = Date.UTC(new Date(time).getUTCFullYear(), 0, 1);

    // Where we are round the orbit, as an angle, carrying the fraction of the
    // day rather than only whole days — declination moves by a third of a degree
    // between one midnight and the next around an equinox.
    const gamma = 2 * Math.PI * ((time - start) / 86400000) / 365;

    const cos = n => Math.cos(n * gamma);
    const sin = n => Math.sin(n * gamma);

    return {
        /**
         * Declination: how far north or south the sun has wandered.
         *
         * Spencer's series rather than the single sine that was here before.
         * The simple form is within about half a degree, which is nothing when
         * the question is how much sun a flat sensor is catching at noon, and
         * five minutes of clock when the question is what time the sun touches
         * the horizon — because near an equinox it is moving fastest and the
         * sun is crossing the horizon most obliquely. Measured against a full
         * solar algorithm across a year, this takes the worst case from just
         * over five minutes to under two.
         */
        declination: (0.006918 - 0.399912 * cos(1) + 0.070257 * sin(1)
            - 0.006758 * cos(2) + 0.000907 * sin(2)
            - 0.002697 * cos(3) + 0.00148 * sin(3)) / RADIANS,

        // The equation of time — the earth's orbit is neither circular nor
        // upright, so true solar noon drifts by up to a quarter of an hour
        // across the year.
        equation: 229.18 * (0.000075 + 0.001868 * cos(1) - 0.032077 * sin(1)
            - 0.014615 * cos(2) - 0.040849 * sin(2))
    };
}

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
    const {declination, equation} = solarYear(time);

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
 * How far below the geometric horizon the sun's centre sits when a sunrise is
 * called.
 *
 * The standard figure, and it is two effects at once: the atmosphere bends the
 * sun's image up by about 34 arcminutes, and what people call sunrise is the
 * first edge of the disc rather than its centre, which is another 16. Without it
 * every time here would be some minutes late in the morning and early in the
 * evening.
 *
 * Deliberately not applied to `sunHeight`, which answers a different question:
 * how much sunlight is landing on a flat sensor. That wants the geometry.
 */
const HORIZON = -0.833;

/**
 * When the sun comes up and goes down, on the day a moment falls in.
 *
 * Solved rather than searched: the hour angle at which the sun sits on the
 * horizon comes straight out of the same spherical triangle `sunHeight` uses, so
 * there is nothing to scan for. Both answers are the sun's own — no clock, no
 * timezone, and no network.
 *
 * Above the arctic circle the sun may not cross the horizon at all, and in that
 * case there is no time to report rather than a wrong one, so both come back
 * null with `up` saying which kind of day it is.
 *
 * @param {number} time - Any moment on the day in question, in milliseconds
 * @param {number} latitude - Degrees north
 * @param {number} longitude - Degrees east, so negative through the Americas
 * @returns {Object} sunrise, sunset and whether the sun is up all day
 */
export function sunTimes(time, latitude, longitude) {
    if (!Number.isFinite(time) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {sunrise: null, sunset: null, up: null};
    }

    const date = new Date(time);
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const {declination, equation} = solarYear(time);

    const cosHour = (Math.sin(RADIANS * HORIZON)
        - Math.sin(RADIANS * latitude) * Math.sin(RADIANS * declination))
        / (Math.cos(RADIANS * latitude) * Math.cos(RADIANS * declination));

    // Outside ±1 the sun never reaches the horizon: it is either up for the
    // whole day or down for it.
    if (cosHour > 1) return {sunrise: null, sunset: null, up: false};
    if (cosHour < -1) return {sunrise: null, sunset: null, up: true};

    // Degrees from noon, at fifteen to the hour.
    const hourAngle = Math.acos(cosHour) / RADIANS / 15;

    // Back out of solar time the same way sunHeight goes into it.
    const utcHours = solar => solar - longitude / 15 - equation / 60;

    return {
        sunrise: midnight + utcHours(12 - hourAngle) * 3600000,
        sunset: midnight + utcHours(12 + hourAngle) * 3600000,
        up: null
    };
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
