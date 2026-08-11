import {colour} from './palette.js';

/**
 * The windgram, as settings.
 *
 * The drawing is modelled on the Canadian RASP windgram, which is a dense chart
 * with a lot of conventions baked into it — how tall each strip is, how far
 * apart the barbs sit, which contours get drawn. All of that lives here so the
 * renderer stays about geometry and the model stays about weather.
 *
 * The one thing deliberately *not* here is the stability palette: the colours
 * and thresholds of the lapse-rate bands are already configuration, in
 * `bands.js`, and the windgram reads the same table the tiles and the tag do.
 * A pilot who has learned what orange means on this site should not find it
 * means something else on this chart.
 */

/**
 * How much of the day one column of the drawing covers.
 *
 * The stations log every five minutes, which is far finer than this drawing
 * can show: at ten minutes the barbs were still shouldering each other and
 * being thinned out again by the renderer, which meant the extra columns bought
 * nothing but noise in the stability bands. Half an hour is about the width a
 * barb needs to be read, so every column now carries one, and averaging six
 * buckets into each takes the edge off a single gusty reading.
 */
export const COLUMN_MS = 30 * 60 * 1000;

/**
 * How high the drawing goes, in metres above sea level.
 *
 * Above the top station, because the interesting part of a soaring day — where
 * the thermals stop — is usually above every sensor we have. Not far above it,
 * though: everything up there is extrapolated from one measured gradient, and a
 * taller panel spends more of its height on the guess and less on the part that
 * was measured.
 */
export const CEILING = 3000;

/**
 * A little air under the lowest station, so its barbs and the terrain below it
 * are not jammed against the axis.
 */
export const GROUND_MARGIN = 60;

/** Geometry, in pixels. */
export const LAYOUT = {
    // Room for the metre labels down the left and the foot labels down the
    // right, matching the RASP's two-scale altitude axis.
    left: 62,
    right: 58,
    top: 26,
    // The stability legend and the two lines of footnotes beneath it.
    bottom: 112,
    panel: 360,
    strip: 26,
    stripGap: 3,
    // Between the last strip and the top of the altitude panel.
    stripToPanel: 8
};

/**
 * Roughly how far apart the barbs sit along the time axis. Closer than this and
 * the feathers of one tangle with the shaft of the next.
 */
export const BARB_SPACING = 26;

/**
 * How far above its station a barb is drawn, in feet.
 *
 * Purely so it can be seen. Sitting exactly on the station's own height put
 * every barb on top of that station's dashed rule and its name, which is the
 * busiest line on the drawing. The rule stays at the true elevation; only the
 * barb is lifted clear of it.
 */
export const BARB_OFFSET_FEET = 500;

/**
 * The strips above the altitude panel, top to bottom, exactly as the RASP
 * stacks them. `read` takes a column of the model and returns the value; `nice`
 * is the smallest range the axis is allowed to shrink to, so a still day does
 * not get a lift axis in hundredths.
 * @type {Object[]}
 */
export const STRIPS = [
    {
        key: 'pressure',
        label: 'pres.',
        unit: 'kPa',
        colour: colour('strip-pressure'),
        digits: 1,
        // Pressure never sits near zero, so this strip is the one that scales
        // to its own range rather than filling from a baseline of nothing.
        zeroed: false,
        nice: 0.4,
        read: column => column.pressure
    },
    {
        key: 'lift',
        label: 'Lift',
        unit: 'm/s',
        colour: colour('strip-lift'),
        digits: 1,
        zeroed: true,
        nice: 1,
        estimated: true,
        read: column => column.lift
    },
    {
        key: 'cloud',
        label: 'Cloud',
        unit: '%',
        // The chart's own pair, by name rather than by matching hex, so a
        // reader moving between the drawing and the chart is not relearning
        // them and neither can be changed without the other.
        colour: colour('series-cloud'),
        digits: 0,
        zeroed: true,
        // Always against the whole of it, so a scattered morning is not
        // stretched up the strip to look like an overcast.
        fixed: [0, 100],
        // Modelled rather than sensed — this is the RASP's own cloud row, and
        // nothing on the hillside is looking up.
        estimated: true,
        read: column => column.cloud
    },
    {
        key: 'shade',
        // Not "Cloud", which is what the RASP calls this row and what a
        // pyranometer cannot actually tell you. See `lib/solar.js`.
        label: 'Shade',
        unit: '%',
        colour: colour('series-shade'),
        digits: 0,
        zeroed: true,
        // A percentage, always drawn against the whole of it, so a thin haze is
        // not stretched up the strip to look like an overcast.
        fixed: [0, 100],
        estimated: true,
        read: column => column.shade === null ? null : column.shade * 100
    },
    {
        key: 'rain',
        label: 'Rain',
        unit: 'mm/hr',
        colour: colour('strip-rain'),
        digits: 2,
        zeroed: true,
        nice: 1,
        read: column => column.rain
    }
];

/** Isotherms are drawn every this many degrees, the way the RASP does. */
export const ISOTHERM_STEP = 5;

/**
 * How close the air has to come to its dew point before the drawing calls it
 * cloud. The RASP's own footnote gives this figure, and it is kept the same so
 * the two charts can be read side by side.
 */
export const CLOUD_DEPRESSION = 0.5;

/** How dark the extrapolated air above the top station is knocked back. */
export const EXTRAPOLATED_OPACITY = 0.45;
