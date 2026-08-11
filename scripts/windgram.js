import {
    LAYOUT, STRIPS, BARB_SPACING, BARB_OFFSET_FEET, COLUMN_MS, EXTRAPOLATED_OPACITY
} from './config/rasp.js';
import {LAPSE} from './config/bands.js';
import {FEET} from './rasp.js';
import {barbPath, barbCounts, CALM_RINGS} from './lib/barb.js';
import {escape} from './lib/markup.js';
import {reveal} from './lib/reveal.js';
import {sunTimes} from './lib/solar.js';
import {pointAt} from './config/compass.js';

/**
 * The windgram, drawn.
 *
 * A vertical slice through the day: time across, height up, and the stability
 * of the air as the colour of the slab between two stations. Everything else on
 * it — the barbs, the isotherms, the strips along the top — answers a question
 * a pilot asks before driving to launch, and answers it in the same notation
 * the RASP forecast uses, so the two can be read against each other.
 *
 * The parts of the drawing that are measured and the parts that are worked out
 * look different on purpose. Between the stations the air is interpolated and
 * drawn solid. Above the top station it is extrapolated from the last measured
 * gradient and drawn faded, with the boundary ruled. The lift and cloud strips
 * are derived rather than sensed, and say so.
 */

// Ticks every this many metres above the stations, where there is nothing
// measured to hang a label on.
const TICK_STEP = 500;

// A round tick this close to a station's own label would collide with it, and
// the station is the one worth keeping.
const TICK_CLEARANCE = 140;

const HOUR = 3600000;

// How big a target each barb gets. Well over the size of the mark itself,
// because the mark is a few hairlines and the pointer is often a fingertip.
const HIT_RADIUS = 13;

/** The tap-a-barb popup. Fixed, because two short lines never need more. */
const TIP = {width: 78, height: 36, gap: 10};

/**
 * Counts drawings, so each can name its own patterns and clip.
 *
 * A page can hold more than one of these — the measured day and the forecast
 * sit in the same panel — and `url(#id)` resolves against the whole document,
 * not the SVG it was written in. Sharing an id meant the second drawing clipped
 * itself to the first one's panel, which put its topmost barbs outside its own
 * frame and into the strips above.
 */
let drawings = 0;

/**
 * How finely the stability field is sampled, in pixels.
 *
 * A row per pixel down the panel, because the eye picks out a one-pixel jog in a
 * near-horizontal band edge immediately, and two pixels across, because it does
 * not pick out the same jog sideways. Cheap either way: the field is walked with
 * a moving index rather than searched, so this is a few hundred thousand
 * additions on a redraw.
 */
const FIELD_STEP = {x: 2, y: 1};

/**
 * A path through points, curved rather than ruled.
 *
 * The model publishes on the hour, and a line drawn straight between those
 * hours arrives with a visible corner at every one of them — which reads as the
 * air changing direction on the hour, when it is really the drawing running out
 * of samples. A Catmull-Rom spline through the same points has no corners and
 * claims nothing extra: it still passes through every value the model gave.
 *
 * @param {Object[]} points - {x, y} in order
 * @returns {string} An SVG path definition
 */
function curveThrough(points) {
    const at = point => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`;

    if (points.length < 3) {
        return points.map((point, index) => `${index ? 'L' : 'M'}${at(point)}`).join('');
    }

    let d = `M${at(points[0])}`;

    for (let i = 0; i < points.length - 1; i++) {
        const before = points[i - 1] ?? points[i];
        const from = points[i];
        const to = points[i + 1];
        const after = points[i + 2] ?? to;

        // The classic Catmull-Rom to Bézier conversion: each control point is a
        // sixth of the way along the chord through its neighbours.
        const first = {x: from.x + (to.x - before.x) / 6, y: from.y + (to.y - before.y) / 6};
        const second = {x: to.x - (after.x - from.x) / 6, y: to.y - (after.y - from.y) / 6};

        d += `C${at(first)} ${at(second)} ${at(to)}`;
    }

    return d;
}

/**
 * A lapse rate at a height, from the samples up one column.
 *
 * Held flat below the lowest sample and above the highest rather than
 * extrapolated: past the last layer the model published there is no gradient to
 * continue, and inventing one would paint a band nothing forecast.
 *
 * @param {Object[]} points - Ascending {elevation, rate}
 * @param {number} metres - The height to read
 * @param {number} from - Where in the samples to start looking
 * @returns {number} ºC per 1000 ft
 */
function rateAtFrom(points, metres, from) {
    if (metres <= points[0].elevation) return points[0].rate;

    const last = points.at(-1);
    if (metres >= last.elevation) return last.rate;

    const below = points[from];
    const above = points[from + 1];
    const share = (metres - below.elevation) / (above.elevation - below.elevation);

    return below.rate + share * (above.rate - below.rate);
}


/**
 * Round numbers for a strip's axis.
 * @param {number[]} values - The readings in the strip
 * @param {Object} strip - Its definition
 * @returns {?Object} lo and hi, or null when the strip has nothing to draw
 */
function stripScale(values, strip) {
    if (strip.fixed) return {lo: strip.fixed[0], hi: strip.fixed[1]};
    if (!values.length) return null;

    const low = Math.min(...values);
    const high = Math.max(...values);

    // A strip whose whole day sits under its threshold is left as an empty
    // frame. The RASP does the same with its lift and rain rows, and for the
    // same reason: a day with a hundredth of a millimetre of drizzle in it,
    // scaled to fill the strip, reads as weather when it is nothing at all.
    if (strip.threshold !== undefined && high < strip.threshold) return null;

    if (strip.zeroed) {
        // Rain and lift are quantities, not levels: their baseline is nothing,
        // and a strip that stretched a drizzle to full height would read as a
        // downpour.
        return {lo: 0, hi: Math.max(high * 1.15, strip.nice ?? 1)};
    }

    const span = Math.max(high - low, strip.nice ?? 1);
    const middle = (high + low) / 2;

    return {lo: middle - span / 2, hi: middle + span / 2};
}

export class Windgram {
    /**
     * The same drawing serves the day that has happened and the day that is
     * forecast. What differs between them is not geometry — it is which strips
     * run along the top, how high the barbs are lifted off their level, and what
     * the drawing has to admit about where its numbers came from. Those are
     * options; everything else reads the model.
     *
     * @param {HTMLElement} host - The element the drawing goes into
     * @param {Object} [options] - strips, barbOffsetFeet, empty and footnotes
     */
    constructor(host, options = {}) {
        this.host = host;
        this.model = null;
        this.id = `windgram-${drawings += 1}`;

        this.strips = options.strips ?? STRIPS;
        this.barbOffsetFeet = options.barbOffsetFeet ?? BARB_OFFSET_FEET;
        this.empty = options.empty ?? 'Not enough logged today to draw the profile yet.';
        this.sentences = options.footnotes ?? ((model, zone) => this.measuredFootnotes(model, zone));

        this.redraw = () => this.draw();

        if (typeof ResizeObserver !== 'undefined') {
            this.observer = new ResizeObserver(() => this.scheduleDraw());
            this.observer.observe(host);
        } else {
            window.addEventListener('resize', this.redraw);
        }

        this.bindPointer();
    }

    /**
     * @returns {void}
     */
    destroy() {
        this.observer?.disconnect();
        window.removeEventListener('resize', this.redraw);
        cancelAnimationFrame(this.frame);
    }

    /**
     * @returns {void}
     */
    scheduleDraw() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(this.redraw);
    }

    /**
     * @param {?Object} model - A model from buildWindgram
     * @returns {void}
     */
    setModel(model) {
        this.model = model;
        this.draw();
    }

    /**
     * Where a moment sits across the drawing.
     * @param {number} time - Milliseconds
     * @returns {number} An x coordinate
     */
    x(time) {
        const span = Math.max(this.model.lastTime - this.model.dayStart, HOUR);
        return this.left + ((time - this.model.dayStart) / span) * (this.right - this.left);
    }

    /**
     * Where a height sits up the drawing.
     * @param {number} metres - Height above sea level
     * @returns {number} A y coordinate
     */
    y(metres) {
        const {floor, ceiling} = this.model;
        return this.bottom - ((metres - floor) / (ceiling - floor)) * (this.bottom - this.top);
    }

    /**
     * A path through points — curved where the drawing is a continuous field,
     * ruled where it is a handful of measurements that should look like one.
     * @param {Object[]} points - {x, y} in order
     * @returns {string} An SVG path definition
     */
    path(points) {
        return curveThrough(points);
    }

    /**
     * The moment at an x coordinate — `x` run backwards.
     * @param {number} x - An x coordinate
     * @returns {number} Milliseconds
     */
    timeAt(x) {
        const span = Math.max(this.model.lastTime - this.model.dayStart, HOUR);
        return this.model.dayStart + ((x - this.left) / (this.right - this.left)) * span;
    }

    /**
     * The height at a y coordinate — `y` run backwards.
     * @param {number} y - A y coordinate
     * @returns {number} Metres above sea level
     */
    metresAt(y) {
        const {floor, ceiling} = this.model;
        return floor + ((this.bottom - y) / (this.bottom - this.top)) * (ceiling - floor);
    }

    /**
     * Draws at whatever size the container currently is.
     * @returns {void}
     */
    draw() {
        const width = Math.round(this.host.clientWidth);

        // A hidden panel has no width; it will be drawn when it is shown.
        if (!width) return;

        if (!this.model?.columns?.length) {
            this.host.innerHTML = `<p class="chart-empty">${escape(this.empty)}</p>`;
            return;
        }

        this.left = LAYOUT.left;
        this.right = width - LAYOUT.right;

        const strips = this.strips.length * (LAYOUT.strip + LAYOUT.stripGap);
        this.top = LAYOUT.top + strips + LAYOUT.stripToPanel;
        this.bottom = this.top + LAYOUT.panel;

        // SVG text does not wrap, so the footnotes are broken into lines here
        // and the drawing is grown to fit however many that turns out to be.
        this.notes = this.footnotes();
        const height = this.bottom + LAYOUT.bottom + Math.max(0, this.notes.length - 2) * 13;

        this.host.innerHTML = `
            <svg class="windgram-svg" width="${width}" height="${height}"
                 viewBox="0 0 ${width} ${height}" role="img"
                 aria-label="Wind, stability and cloud through the day, from the ground to ${
                     Math.round(this.model.ceiling)} metres">
                ${this.defs()}
                ${this.renderStrips()}
                ${this.renderPanel()}
                ${this.renderAltitudeAxis()}
                ${this.renderHours()}
                ${this.renderLegend(width, height)}
                <g class="windgram-readout" hidden>
                    <line class="windgram-crosshair" y1="${LAYOUT.top}" y2="${this.bottom}"></line>
                    <g class="windgram-values"></g>
                </g>
                <g class="windgram-tip" hidden>
                    <rect class="windgram-tip-box" width="${TIP.width}" height="${TIP.height}" rx="5"></rect>
                    <text class="windgram-tip-point"></text>
                    <text class="windgram-tip-speed"></text>
                </g>
            </svg>`;

        this.svg = this.host.querySelector('.windgram-svg');
        this.readout = this.host.querySelector('.windgram-readout');
        this.crosshair = this.host.querySelector('.windgram-crosshair');
        this.valueLayer = this.host.querySelector('.windgram-values');
        this.tip = this.host.querySelector('.windgram-tip');
    }

    /**
     * The hatch the drawing marks cloud with, and the clip that keeps the
     * coloured slabs inside the panel.
     * @returns {string} SVG markup
     */
    defs() {
        return `<defs>
            <pattern id="${this.id}-cloud" width="7" height="7" patternUnits="userSpaceOnUse"
                     patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(30,58,138,.35)" stroke-width="2.2"></line>
            </pattern>
            <pattern id="${this.id}-missing" width="8" height="8" patternUnits="userSpaceOnUse"
                     patternTransform="rotate(-45)">
                <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(22,32,43,.10)" stroke-width="3"></line>
            </pattern>
            <clipPath id="${this.id}-panel">
                <rect x="${this.left}" y="${this.top}"
                      width="${this.right - this.left}" height="${this.bottom - this.top}"></rect>
            </clipPath>
        </defs>`;
    }

    /**
     * How wide one column of the model is, in pixels.
     * @returns {number} Width, never less than a hairline
     */
    columnWidth() {
        const span = this.model.columnMs ?? COLUMN_MS;

        return Math.max(1, this.x(this.model.dayStart + span) - this.x(this.model.dayStart));
    }

    /**
     * Sunrise and sunset, where they fall inside the drawing.
     *
     * Usually only sunrise: this chart stops at the last reading a station
     * logged, so on any afternoon the sunset is still hours off the right-hand
     * edge and there is nothing to mark. Whichever of the two lands inside the
     * frame is drawn, and the other is simply not there.
     *
     * The station's own coordinates and the day it is drawing are all this
     * needs — the same sums the shade strip already runs.
     *
     * @returns {string} SVG markup
     */
    renderSun() {
        const {sunrise, sunset} = sunTimes(this.model.dayStart + 12 * HOUR,
            this.model.latitude, this.model.longitude);

        return [{at: sunrise, label: 'Sunrise'}, {at: sunset, label: 'Sunset'}]
            .filter(mark => Number.isFinite(mark.at)
                && mark.at >= this.model.dayStart && mark.at <= this.model.lastTime)
            .map(mark => {
                const x = this.x(mark.at);

                return `<g class="windgram-sun">
                    <line class="windgram-sun-line" x1="${x.toFixed(1)}" y1="${this.top}"
                          x2="${x.toFixed(1)}" y2="${this.bottom}"></line>
                    <text class="windgram-sun-label" x="${(x + 4).toFixed(1)}"
                          y="${(this.top + 11).toFixed(1)}">${escape(mark.label)}</text>
                </g>`;
            }).join('');
    }

    /**
     * The strips along the top: pressure, lift, cloud and rain.
     *
     * Each is a filled area on its own scale with its label outside the plot,
     * which is what makes four unrelated units stackable in the space one chart
     * would take. Two of them are derived rather than measured and carry a mark
     * saying so.
     *
     * @returns {string} SVG markup
     */
    renderStrips() {
        return this.strips.map((strip, index) => {
            const top = LAYOUT.top + index * (LAYOUT.strip + LAYOUT.stripGap);
            const bottom = top + LAYOUT.strip;

            const readings = this.model.columns.map(column => strip.read(column));
            const scale = stripScale(readings.filter(value => value !== null && Number.isFinite(value)), strip);

            const frame = `<rect class="windgram-strip-bed" x="${this.left}" y="${top}"
                                 width="${this.right - this.left}" height="${LAYOUT.strip}"></rect>`;

            const name = `
                <text class="windgram-strip-label" x="${this.left - 8}" y="${top + LAYOUT.strip / 2 + 4}"
                      text-anchor="end" fill="${strip.colour}">${escape(strip.label)}${
                          strip.estimated ? '<tspan class="windgram-estimated">*</tspan>' : ''}</text>
                <text class="windgram-strip-unit" x="${this.left + 6}" y="${top + LAYOUT.strip / 2 + 4}"
                      fill="${strip.colour}">(${escape(strip.unit)})</text>`;

            if (!scale) return `<g>${frame}${name}</g>`;

            const at = value =>
                bottom - ((value - scale.lo) / (scale.hi - scale.lo)) * LAYOUT.strip;

            // Broken into runs so a gap in the readings is a gap in the fill
            // rather than a shape ruled straight across it.
            let area = '';
            let run = [];

            const flush = () => {
                if (run.length < 2) { run = []; return; }

                area += `<path class="windgram-strip-fill" fill="${strip.colour}"
                               d="M${run[0].x.toFixed(1)} ${bottom.toFixed(1)}L${
                                   this.path(run).slice(1)}L${
                                   run.at(-1).x.toFixed(1)} ${bottom.toFixed(1)}Z"></path>`;

                run = [];
            };

            this.model.columns.forEach((column, index) => {
                const value = readings[index];

                if (value === null || !Number.isFinite(value)) return flush();

                run.push({x: this.x(column.time), y: at(Math.min(Math.max(value, scale.lo), scale.hi))});
            });

            flush();

            // Pinned to the ends of the strip rather than placed at their own
            // heights: twenty-six pixels is not enough for two numbers to sit
            // wherever their values fall without touching.
            const ticks = [
                [scale.hi, top + 9],
                [scale.lo + (scale.hi - scale.lo) / 2, bottom - 1]
            ].map(([value, y]) => `
                <text class="windgram-strip-tick" x="${this.right + 6}" y="${y.toFixed(1)}"
                      fill="${strip.colour}">${value.toFixed(strip.digits)}</text>`).join('');

            return `<g>${frame}${area}${name}${ticks}</g>`;
        }).join('');
    }

    /**
     * The altitude panel: stability, cloud, contours and barbs.
     * @returns {string} SVG markup
     */
    renderPanel() {
        return `<g>
            <rect class="windgram-bed" x="${this.left}" y="${this.top}"
                  width="${this.right - this.left}" height="${this.bottom - this.top}"></rect>
            <g clip-path="url(#${this.id}-panel)">
                ${this.renderMissing()}
                ${this.renderStabilityField()}
                ${this.renderCloud()}
                ${this.renderTerrain()}
                ${this.renderIsotherms()}
                ${this.renderThermalTop()}
                ${this.renderClimbTop()}
                ${this.renderCloudBase()}
                ${this.renderBarbs()}
                ${this.renderSun()}
            </g>
            <rect class="windgram-frame" x="${this.left}" y="${this.top}"
                  width="${this.right - this.left}" height="${this.bottom - this.top}"></rect>
        </g>`;
    }


    /**
     * The coloured air, as a field rather than as a stack of blocks.
     *
     * A slab of air between two model levels is five hundred metres deep and an
     * hour wide, and drawing one rectangle per slab makes the sky look like
     * masonry — which is both ugly and a lie, because the boundary between
     * unstable and stable air is a surface running diagonally through the day,
     * not a staircase.
     *
     * The RASP solves this by contour-filling, and this does the same thing by
     * the same reasoning: a layer's lapse rate is treated as a sample at the
     * middle of that layer rather than as a property of the whole block, the
     * samples are interpolated in height and in time, and the result is
     * flood-filled by band. Nothing new is claimed — the samples are exactly the
     * numbers behind the slabs — but the picture between them is continuous,
     * which is what the air actually is.
     *
     * The measured drawing gets the same treatment, and the objection to it is
     * worth answering rather than dodging: three stations do not resolve the air
     * between them. Neither did the blocks, though — a stack of hard-edged slabs
     * claims the stability changes discontinuously at the exact height of a
     * thermometer, which is a stronger claim than a gradient, not a weaker one.
     * What genuinely must survive is the difference between air that was
     * measured and air that was not, so the boundary between them is tracked
     * through the field and everything above it is drawn knocked back, exactly
     * as the slabs were.
     *
     * @returns {string} SVG markup
     */
    renderStabilityField() {
        const columns = this.model.columns;

        const profiles = columns.map(column => {
            const points = [...column.segments, column.above]
                .filter(slab => slab && Number.isFinite(slab.rate))
                .map(slab => ({elevation: (slab.from + slab.to) / 2, rate: slab.rate}))
                .sort((a, b) => a.elevation - b.elevation);

            return points.length ? points : null;
        });

        // The height above which this column was never measured. On the
        // forecast nothing is extrapolated and this sits at the ceiling, so the
        // whole field is drawn solid.
        const measured = columns.map(column => {
            const solid = column.segments.filter(slab => !slab.extrapolated);

            if (solid.length) return solid.at(-1).to;

            return column.segments[0]?.from ?? this.model.floor;
        });

        const paintTop = this.top;
        const paintBottom = Math.min(this.bottom, this.y(this.model.ground));

        const rows = Math.max(0, Math.ceil((paintBottom - paintTop) / FIELD_STEP.y));
        const cells = Math.max(0, Math.ceil((this.right - this.left) / FIELD_STEP.x));

        if (!rows || !cells) return '';

        // One band index per cell, or -1 where the model said nothing. A typed
        // array because this is a few hundred thousand cells on a wide screen
        // and it is rebuilt on every resize.
        const grid = new Int8Array(rows * cells).fill(-1);

        // Heights are the same down every cell of the grid, so they are worked
        // out once rather than once per column. Bottom row first, so the walk up
        // each column is in ascending height.
        const heights = Array.from({length: rows}, (unused, row) =>
            this.metresAt(paintTop + (rows - 1 - row + 0.5) * FIELD_STEP.y));

        // The band a rate falls in, looked up once per threshold rather than
        // once per cell — a linear scan of nine entries, several hundred
        // thousand times over, is most of the cost of the drawing otherwise.
        const bandOf = rate => {
            for (let i = 0; i < LAPSE.length; i++) if (rate <= LAPSE[i].max) return i;
            return LAPSE.length - 1;
        };

        for (let cell = 0; cell < cells; cell++) {
            const time = this.timeAt(this.left + (cell + 0.5) * FIELD_STEP.x);

            let index = 0;
            while (index < columns.length - 2 && columns[index + 1].time < time) index += 1;

            const before = profiles[index];
            const after = profiles[index + 1] ?? before;

            // An hour the model lost is left uncoloured rather than bridged:
            // the hatch underneath is what says nothing was forecast here.
            if (!before || !after) continue;

            const from = columns[index].time;
            const to = columns[index + 1]?.time ?? from;
            const share = to === from ? 0 : Math.min(1, Math.max(0, (time - from) / (to - from)));

            const edge = (1 - share) * measured[index] + share * (measured[index + 1] ?? measured[index]);

            // Walked upward with a moving index into each profile rather than
            // searched per row, which is what makes a per-pixel field affordable.
            let low = 0;
            let high = 0;

            for (let row = 0; row < rows; row++) {
                const metres = heights[row];

                while (low < before.length - 2 && before[low + 1].elevation < metres) low += 1;
                while (high < after.length - 2 && after[high + 1].elevation < metres) high += 1;

                const rate = (1 - share) * rateAtFrom(before, metres, low)
                    + share * rateAtFrom(after, metres, high);

                // Band and whether it was measured, packed into one cell so the
                // run-merging below breaks a run wherever either changes.
                grid[(rows - 1 - row) * cells + cell] =
                    bandOf(rate) + (metres > edge ? LAPSE.length : 0);
            }
        }

        // Merged along each row before anything is written out, so a band that
        // covers half the sky is a handful of rectangles rather than hundreds.
        // Twice as many buckets as bands: the measured half and the faded half
        // of each are separate fills.
        const runs = [...LAPSE, ...LAPSE].map(() => []);

        for (let row = 0; row < rows; row++) {
            let cell = 0;

            while (cell < cells) {
                const value = grid[row * cells + cell];

                if (value < 0) { cell += 1; continue; }

                let end = cell;
                while (end + 1 < cells && grid[row * cells + end + 1] === value) end += 1;

                const x = this.left + cell * FIELD_STEP.x;
                // Half a pixel over, or antialiasing draws a pale seam between
                // every pair of rows and runs.
                const width = (end - cell + 1) * FIELD_STEP.x + 0.5;
                const y = paintTop + row * FIELD_STEP.y;

                runs[value].push(`M${x.toFixed(1)} ${y.toFixed(1)}h${width.toFixed(1)}v${
                    FIELD_STEP.y + 0.5}h${(-width).toFixed(1)}z`);

                cell = end + 1;
            }
        }

        const bands = runs.map((shapes, index) => {
            if (!shapes.length) return '';

            const faded = index >= LAPSE.length;
            const entry = LAPSE[index % LAPSE.length];

            return `<path fill="${entry.color}"${
                faded ? ` opacity="${EXTRAPOLATED_OPACITY}"` : ''} d="${shapes.join('')}"></path>`;
        }).join('');

        // The line above which nothing was measured. Without it the faded air
        // reads as haze rather than as the edge of what we know.
        const top = this.model.stations.at(-1)?.elevation;

        const boundary = top === undefined ? '' : `
            <line class="windgram-extrapolated-edge" x1="${this.left}" x2="${this.right}"
                  y1="${this.y(top).toFixed(1)}" y2="${this.y(top).toFixed(1)}"></line>`;

        return `<g class="windgram-stability">${bands}${boundary}</g>`;
    }

    /**
     * Air nothing was reporting from.
     *
     * The lowest station comes online partway through most mornings, and until
     * it does there is no lower end to the profile — so the bottom of the panel
     * has nothing to colour. Left as bed it read as a white hole punched in the
     * chart; hatched, it reads as the absence it is, and does not compete with
     * the stability colours for attention.
     *
     * @returns {string} SVG markup
     */
    renderMissing() {
        const width = this.columnWidth();

        const cells = this.model.columns.map(column => {
            const lowest = column.levels[0]?.elevation ?? this.model.ceiling;
            if (lowest <= this.model.ground) return '';

            const x = this.x(column.time) - width / 2;
            const top = this.y(lowest);

            return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}"
                          width="${(width + 0.6).toFixed(1)}"
                          height="${Math.max(0, this.y(this.model.ground) - top).toFixed(1)}"
                          fill="url(#${this.id}-missing)"></rect>`;
        }).join('');

        return `<g class="windgram-missing">${cells}</g>`;
    }

    /**
     * Hatching where the air is within half a degree of its dew point.
     * @returns {string} SVG markup
     */
    renderCloud() {
        const width = this.columnWidth();

        const cells = this.model.columns.map(column => {
            const x = this.x(column.time) - width / 2;

            return column.clouds.map(cloudBand => {
                const top = this.y(cloudBand.to);
                const height = this.y(cloudBand.from) - top;

                return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}"
                              width="${(width + 0.6).toFixed(1)}" height="${Math.max(0, height).toFixed(1)}"
                              fill="url(#${this.id}-cloud)"></rect>`;
            }).join('');
        }).join('');

        return `<g class="windgram-clouds">${cells}</g>`;
    }

    /**
     * The ground under the lowest station, so the drawing sits on something.
     * @returns {string} SVG markup
     */
    renderTerrain() {
        const y = this.y(this.model.ground);

        return `<rect class="windgram-terrain" x="${this.left}" y="${y.toFixed(1)}"
                      width="${this.right - this.left}" height="${(this.bottom - y).toFixed(1)}"></rect>`;
    }

    /**
     * The temperature contours, each labelled where there is room.
     * @returns {string} SVG markup
     */
    renderIsotherms() {
        const lines = this.model.isotherms.map(isotherm => {
            const paths = isotherm.runs.map(run => {
                const d = this.path(run.map(point =>
                    ({x: this.x(point.time), y: this.y(point.elevation)})));

                return `<path class="windgram-isotherm" d="${d}"></path>`;
            }).join('');

            // Labelled a third of the way along the longest run: near enough to
            // the middle to be findable, far enough from it that neighbouring
            // contours do not stack their labels in a column.
            const longest = isotherm.runs.reduce(
                (best, run) => run.length > best.length ? run : best, isotherm.runs[0]);

            const point = longest[Math.floor(longest.length / 3)];

            // Kept off the frame: a contour that runs along the top of the
            // panel would otherwise print its label half outside it.
            const y = point
                ? Math.min(Math.max(this.y(point.elevation) - 3, this.top + 10), this.bottom - 4)
                : 0;

            const label = point
                ? `<text class="windgram-isotherm-label" x="${this.x(point.time).toFixed(1)}"
                         y="${y.toFixed(1)}" text-anchor="middle">${isotherm.value}</text>`
                : '';

            return paths + label;
        }).join('');

        return `<g class="windgram-isotherms">${lines}</g>`;
    }

    /**
     * The top of the lift: a line across the drawing with a glider on it.
     *
     * This is the one line on the chart that is a forecast rather than a
     * reading, and it is the one most likely to be looked at first, so it is
     * drawn heaviest and marked with the same glyph the site uses for flying.
     *
     * @returns {string} SVG markup
     */
    renderThermalTop() {
        const points = this.model.columns
            .filter(column => column.thermalTop !== null)
            .map(column => ({x: this.x(column.time), y: this.y(column.thermalTop)}));

        if (points.length < 2) return '';

        const d = this.path(points);

        // Roughly one glider every hundred pixels, so the line is readable as a
        // thermal top on a phone as well as on a desktop.
        const every = Math.max(1, Math.round(points.length / Math.max(2,
            Math.floor((this.right - this.left) / 110))));

        const gliders = points.map((point, index) => index % every === Math.floor(every / 2)
            ? `<text class="windgram-glider" x="${point.x.toFixed(1)}" y="${(point.y - 7).toFixed(1)}"
                     text-anchor="middle">paragliding</text>`
            : '').join('');

        return `<g class="windgram-thermal">
            <path class="windgram-thermal-line" d="${d}"></path>
            ${gliders}
        </g>`;
    }

    /**
     * How high a wing can actually climb to.
     *
     * A thermal is not one speed all the way up: it peaks about a quarter of the
     * way through the layer and dies out well below the top, so the height where
     * the air stops beating a glider's own sink is meaningfully lower than the
     * height where the bubble finally stops. The line above is where the air
     * gives up; this one is where you would.
     *
     * Drawn dashed and lighter, because it sits under a line that is already
     * there and the pair only reads if one of them is clearly secondary.
     *
     * @returns {string} SVG markup
     */
    renderClimbTop() {
        const runs = [];
        let run = [];

        // Broken into runs so an hour with no usable climb leaves a gap rather
        // than a line ruled optimistically across it.
        this.model.columns.forEach(column => {
            if (column.climbTop === null || column.climbTop === undefined) {
                if (run.length > 1) runs.push(run);
                run = [];
                return;
            }

            run.push({x: this.x(column.time), y: this.y(column.climbTop)});
        });

        if (run.length > 1) runs.push(run);
        if (!runs.length) return '';

        const paths = runs.map(points =>
            `<path class="windgram-climb-line" d="${this.path(points)}"></path>`).join('');

        return `<g class="windgram-climb">${paths}</g>`;
    }

    /**
     * Where a thermal would condense, if it got that far.
     * @returns {string} SVG markup
     */
    renderCloudBase() {
        const points = this.model.columns
            .filter(column => column.cloudBase !== null)
            .map(column => ({x: this.x(column.time), y: this.y(column.cloudBase)}));

        if (points.length < 2) return '';

        return `<path class="windgram-cloudbase" d="${this.path(points)}"></path>`;
    }

    /**
     * A row of barbs at each station's own height.
     *
     * Only three rows, because only three heights were measured. Filling the
     * panel with interpolated barbs would look more like the forecast it is
     * modelled on and mean considerably less.
     *
     * White, as on the RASP — but drawn twice, because the RASP can afford
     * plain white and this cannot. Its background is saturated model output
     * throughout; ours is the site's stability palette, which runs through
     * several near-white bands a white barb would simply vanish into. So each
     * one is laid down first as a dark halo and then in white on top, which
     * reads as white everywhere and stays legible over the pale bands.
     *
     * @returns {string} SVG markup
     */
    renderBarbs() {
        const columns = this.model.columns;
        const perColumn = (this.right - this.left) / Math.max(columns.length, 1);
        const step = Math.max(1, Math.round(BARB_SPACING / Math.max(perColumn, 1)));
        const lift = this.barbOffsetFeet * FEET;

        const marks = [];

        for (let index = Math.floor(step / 2); index < columns.length; index += step) {
            const column = columns[index];
            const x = this.x(column.time);

            column.levels.forEach(level => {
                if (level.windDir === null || level.windSpeed === null) return;

                // Lifted clear of the station's own rule and name. The reading
                // still belongs to the station's true height, which is where
                // that rule is drawn.
                const y = this.y(level.elevation + lift);

                // A level above the ceiling, or below the floor, is air this
                // panel does not draw. The clip would hide it either way, but
                // nothing above the panel should depend on a clip being right:
                // the strips sit up there, and a barb in the rain row is worse
                // than a barb missing.
                if (y < this.top || y > this.bottom) return;

                const at = `${x.toFixed(1)} ${y.toFixed(1)}`;

                const station = this.model.stations.find(entry => entry.key === level.key);

                const reading = {
                    x: x.toFixed(1),
                    y: y.toFixed(1),
                    speed: level.windSpeed.toFixed(1),
                    point: level.windDir === null ? '' : pointAt(level.windDir).abbr,
                    // A measured level belongs to a station and is named for it;
                    // a modelled one is a pressure level and names itself.
                    station: level.label ?? station?.shortName ?? station?.name ?? ''
                };

                // A calm has no direction worth pointing at, so it is marked
                // by rings rather than by a staff aimed down an average of
                // nothing.
                if (barbCounts(level.windSpeed).calm) {
                    marks.push({...reading, calm: true});
                    return;
                }

                // The staff is drawn pointing up and turned to the bearing the
                // wind is coming from, which is what the reading names.
                marks.push({
                    ...reading,
                    d: barbPath(level.windSpeed),
                    transform: `translate(${at}) rotate(${level.windDir.toFixed(0)})`
                });
            });
        }

        /**
         * @param {string} kind - The class suffix, halo or nothing
         * @returns {string} Every mark drawn in one pass
         */
        const pass = kind => marks.map(mark => mark.calm
            ? CALM_RINGS.map(radius =>
                `<circle class="windgram-calm${kind}" cx="${mark.x}" cy="${mark.y}" r="${radius}"></circle>`
            ).join('')
            : `<path class="windgram-barb${kind}" d="${mark.d}" transform="${mark.transform}"></path>`
        ).join('');

        // A barb is a few thin strokes, which is far too small a target for a
        // finger. Each gets an invisible disc over it instead, laid last so it
        // sits above every drawn mark.
        const hits = marks.map(mark => `
            <circle class="windgram-barb-hit" cx="${mark.x}" cy="${mark.y}" r="${HIT_RADIUS}"
                    data-speed="${mark.speed}" data-point="${escape(mark.point)}"
                    data-station="${escape(mark.station)}"
                    role="img" aria-label="${escape(
                        `${mark.station} ${mark.speed} km/h${mark.point ? ` ${mark.point}` : ''}`)}"></circle>`
        ).join('');

        // Every halo first, then every barb: drawn barb by barb, one mark's
        // halo would sit on top of its neighbour's white.
        return `<g class="windgram-barbs">${pass('-halo')}${pass('')}</g>`
            + `<g class="windgram-barb-hits">${hits}</g>`;
    }

    /**
     * Metres down the left, feet down the right, with the stations named.
     * @returns {string} SVG markup
     */
    renderAltitudeAxis() {
        const {floor, ceiling, stations} = this.model;

        const rounded = [];
        for (let metres = Math.ceil(floor / TICK_STEP) * TICK_STEP; metres <= ceiling; metres += TICK_STEP) {
            if (stations.every(station => Math.abs(station.elevation - metres) > TICK_CLEARANCE)) {
                rounded.push({metres});
            }
        }

        const ticks = [
            ...stations.map(station => ({metres: station.elevation, station})),
            ...rounded
        ];

        return `<g class="windgram-altitude">${ticks.map(tick => {
            const y = this.y(tick.metres);

            const rule = tick.station
                ? `<line class="windgram-station-rule" x1="${this.left}" x2="${this.right}"
                         y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>`
                : '';

            const name = tick.station
                ? `<text class="windgram-station-name" x="${this.left + 6}" y="${(y - 5).toFixed(1)}">${
                      escape(tick.station.shortName ?? tick.station.name)}</text>`
                : '';

            return `${rule}${name}
                <text class="windgram-axis${tick.station ? ' is-station' : ''}"
                      x="${this.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${
                          Math.round(tick.metres)}m</text>
                <text class="windgram-axis${tick.station ? ' is-station' : ''}"
                      x="${this.right + 8}" y="${(y + 4).toFixed(1)}">${
                          Math.round(tick.metres / FEET).toLocaleString()}'</text>`;
        }).join('')}</g>`;
    }

    /**
     * The hours along the bottom, in the station's own local time.
     * @returns {string} SVG markup
     */
    renderHours() {
        const {dayStart, lastTime} = this.model;
        const hours = (lastTime - dayStart) / HOUR;

        // On a narrow screen, or early in the day when the drawing is only a
        // few hours wide, the labels are thinned rather than allowed to touch.
        const step = (this.right - this.left) / Math.max(hours, 1) < 34 ? 2 : 1;

        let marks = '';

        for (let hour = 0; hour <= hours; hour += step) {
            const at = dayStart + hour * HOUR;
            const x = this.x(at);

            // Read off the clock rather than counted from the left edge. The
            // measured drawing starts at local midnight, where the two are the
            // same number; the forecast starts at seven in the morning, where
            // they are not.
            const clock = Math.floor((at + (this.model.offset ?? 0)) / HOUR) % 24;

            marks += `<line class="windgram-hour-tick" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}"
                            y1="${this.bottom}" y2="${this.bottom + 4}"></line>
                      <text class="windgram-axis" x="${x.toFixed(1)}" y="${this.bottom + 17}"
                            text-anchor="middle">${String(clock).padStart(2, '0')}</text>`;
        }

        return `<g class="windgram-hours">${marks}</g>`;
    }

    /**
     * The stability key, and the footnotes that say what is measured and what
     * is not.
     * @param {number} width - Chart width
     * @param {number} height - Chart height
     * @returns {string} SVG markup
     */
    renderLegend(width, height) {
        // Clear of the hour labels: the thresholds printed on the band edges
        // are numbers too, and two rows of numbers a few pixels apart read as
        // one confused row.
        const top = this.bottom + 44;
        const bandHeight = 15;

        // The table runs from the most unstable to the most inverted, which is
        // the order it is drawn in and the order a pilot reads it.
        const cells = LAPSE.length;
        const cellWidth = (this.right - this.left) / cells;

        const swatches = LAPSE.map((entry, index) => {
            const x = this.left + index * cellWidth;

            // The threshold between this band and the next, printed on the
            // boundary rather than under the block, because the number is where
            // one condition becomes another.
            const edge = index < cells - 1
                ? `<text class="windgram-legend-edge" x="${(x + cellWidth).toFixed(1)}" y="${top - 4}"
                         text-anchor="middle">${entry.max}</text>`
                : '';

            return `<rect x="${x.toFixed(1)}" y="${top}" width="${(cellWidth + 0.6).toFixed(1)}"
                          height="${bandHeight}" fill="${entry.color}"></rect>${edge}`;
        }).join('');

        // One name per run of bands that share it, so "Conditional Instability"
        // is written once across the four cells it covers rather than four
        // times in a space that fits it none.
        const runs = [];
        LAPSE.forEach((entry, index) => {
            const last = runs.at(-1);
            if (last && last.name === entry.name) last.to = index;
            else runs.push({name: entry.name, from: index, to: index});
        });

        const names = runs.map(run => {
            const centre = this.left + ((run.from + run.to + 1) / 2) * cellWidth;
            const room = (run.to - run.from + 1) * cellWidth;

            // Roughly how wide the name will come out at the legend's own size.
            // A name that does not fit is dropped rather than overprinted onto
            // its neighbour: the colours and the numbers still carry the key,
            // and two overlapping words carry nothing.
            if (run.name.length * 5.4 > room - 6) return '';

            return `<text class="windgram-legend-name" x="${centre.toFixed(1)}" y="${top + bandHeight - 4}"
                          text-anchor="middle">${escape(run.name)}</text>`;
        }).join('');

        const first = height - 12 - (this.notes.length - 1) * 13;

        const footnotes = this.notes.map((line, row) => `
            <text class="windgram-note" x="${this.left}" y="${first + row * 13}">${escape(line)}</text>`).join('');

        return `<g class="windgram-legend">${swatches}${names}${footnotes}</g>`;
    }

    /**
     * What the drawing has to admit about itself, wrapped to the width it has.
     *
     * Every one of these is load-bearing rather than decorative: two of the
     * four strips are derived rather than measured, the air above the top
     * station is a continuation of one gradient, and the thermals start from
     * launch rather than from the valley. A reader who does not know that will
     * over-trust the chart.
     *
     * @returns {string[]} The lines to print, in order
     */
    footnotes() {
        const sentences = this.sentences(this.model, this.zone());

        // Wrapped on a character estimate rather than on measured text: the
        // notes are set in one size in one font, and re-measuring every line
        // through the DOM to save a few pixels of raggedness is not worth the
        // second layout pass.
        const columns = Math.max(24, Math.floor((this.right - this.left) / 4.6));
        const lines = [];

        sentences.forEach(sentence => {
            let line = '';

            sentence.split(' ').forEach(word => {
                if (line && (line + ' ' + word).length > columns) {
                    lines.push(line);
                    line = word;
                    return;
                }

                line = line ? `${line} ${word}` : word;
            });

            if (line) lines.push(line);
        });

        return lines;
    }

    /**
     * How the drawing names the clock its hours are on.
     * @returns {string} A parenthesised offset, or nothing when there is none
     */
    zone() {
        const {offset} = this.model;

        if (offset === undefined || offset === null) return '';

        return ` (UTC${offset > 0 ? '+' : '−'}${Math.abs(Math.round(offset / HOUR))})`;
    }

    /**
     * The footnotes for the day that has already happened.
     *
     * Every one of these is load-bearing rather than decorative: two of the four
     * strips are derived rather than measured, the air above the top station is
     * a continuation of one gradient, and the thermals start from launch rather
     * than from the valley. A reader who does not know that will over-trust the
     * chart.
     *
     * @param {Object} model - The model being drawn
     * @param {string} zone - The clock the hours are on
     * @returns {string[]} The sentences to print, in order
     */
    measuredFootnotes(model, zone) {
        const launch = model.launch?.shortName ?? 'launch';
        const top = model.stations.at(-1)?.shortName ?? 'the top station';

        // Air above the top station is either HRDPS or a continuation of the
        // last measured gradient, and those deserve different amounts of trust.
        const overhead = model.modelledAloft
            ? `Air above ${top} is from the HRDPS model, not measured here`
            : `Air above ${top} is extrapolated from the gradient below it`;

        return [
            `Local lapse rate in ºC per 1000 ft. Wind barbs in km/h. Time${zone}.`,
            'Blue hatching is air within half a degree of its dew point; grey hatching is air no station was reporting from. Barbs sit 500 ft above their station so they clear its line.',
            'The solid line is where a thermal stops climbing; the dashed line under it is where the climb drops below a glider\'s own sink, which is the height worth flying to.',
            `* Shade is measured — how much of the clear-sky sunlight is missing to cloud, haze, smoke or terrain. Cloud is modelled. Lift is worked out from the measured sunlight and profile, with thermals released from ${launch}. ${overhead}.`
        ];
    }

    /**
     * Reading off a column: a crosshair, and the numbers behind that moment.
     * Bound once to the host, so redrawing never has to rebind it.
     * @returns {void}
     */
    bindPointer() {
        const move = event => {
            if (!this.svg || !this.model) return;

            // A barb under the pointer names itself, and the column readout is
            // left alone underneath: one answers "what was the wind here", the
            // other "what was the day doing at this moment".
            const hit = event.target.closest?.('.windgram-barb-hit');
            if (hit) this.showTip(hit);
            else this.hideTip();

            const box = this.svg.getBoundingClientRect();
            const scale = box.width / this.svg.viewBox.baseVal.width;
            const x = (event.clientX - box.left) / scale;

            if (x < this.left || x > this.right) return this.hideReadout();

            const columns = this.model.columns;
            const span = Math.max(this.model.lastTime - this.model.dayStart, HOUR);
            const time = this.model.dayStart + ((x - this.left) / (this.right - this.left)) * span;

            let best = 0;
            for (let i = 1; i < columns.length; i++) {
                if (Math.abs(columns[i].time - time) < Math.abs(columns[best].time - time)) best = i;
            }

            this.showReadout(best);
        };

        this.host.addEventListener('pointermove', move);
        this.host.addEventListener('pointerdown', move);
        this.host.addEventListener('pointerleave', () => {
            this.hideReadout();
            this.hideTip();
        });
    }

    /**
     * Names the barb under the pointer: which way, and how fast.
     *
     * The barb itself is rounded to the nearest five by design, so the popup
     * gives the reading behind it rather than repeating what the feathers
     * already say — otherwise there is no way to tell a rounded-down nine from
     * a rounded-up eleven.
     *
     * @param {SVGElement} hit - The target disc over a barb
     * @returns {void}
     */
    showTip(hit) {
        const x = Number(hit.getAttribute('cx'));
        const y = Number(hit.getAttribute('cy'));

        // Above and to the right, until that would put it outside the panel,
        // then folded back over the barb on whichever side has the room.
        const left = x + TIP.gap + TIP.width > this.right
            ? x - TIP.gap - TIP.width
            : x + TIP.gap;

        const top = y - TIP.gap - TIP.height < this.top
            ? y + TIP.gap
            : y - TIP.gap - TIP.height;

        this.tip.querySelector('.windgram-tip-box').setAttribute('x', left.toFixed(1));
        this.tip.querySelector('.windgram-tip-box').setAttribute('y', top.toFixed(1));

        const point = this.tip.querySelector('.windgram-tip-point');
        point.setAttribute('x', (left + TIP.width / 2).toFixed(1));
        point.setAttribute('y', (top + 15).toFixed(1));
        point.textContent = hit.dataset.point || '—';

        const speed = this.tip.querySelector('.windgram-tip-speed');
        speed.setAttribute('x', (left + TIP.width / 2).toFixed(1));
        speed.setAttribute('y', (top + 28).toFixed(1));
        speed.textContent = `${hit.dataset.speed} km/h`;

        reveal(this.tip, true);
    }

    /**
     * @returns {void}
     */
    hideTip() {
        reveal(this.tip, false);
    }

    /**
     * @param {number} index - Which column to read
     * @returns {void}
     */
    showReadout(index) {
        const column = this.model.columns[index];
        const x = this.x(column.time);

        this.crosshair.setAttribute('x1', x.toFixed(1));
        this.crosshair.setAttribute('x2', x.toFixed(1));

        const clock = new Date(column.time).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});

        // Highest station first, so the list reads down the column of air the
        // same way the panel does.
        const winds = [...column.levels].reverse().map(level => {
            const station = this.model.stations.find(entry => entry.key === level.key);
            const name = station?.shortName ?? station?.name ?? '';

            if (level.windSpeed === null) return `${name} —`;

            // The number behind the barb. A barb is read to the nearest five by
            // design, so without this there is no way to tell a rounded-down
            // nine from a rounded-up eleven.
            const heading = level.windDir === null ? '' : ` ${pointAt(level.windDir).abbr}`;

            return `${name} ${level.windSpeed.toFixed(0)} km/h${heading}`;
        });

        const lines = [
            clock,
            column.thermalTop === null
                ? 'No thermal'
                : `Top ${Math.round(column.thermalTop).toLocaleString()} m`,
            column.climbTop === null || column.climbTop === undefined
                ? null
                : `Climb to ${Math.round(column.climbTop).toLocaleString()} m`,
            column.lift === null ? null : `Lift ${column.lift.toFixed(1)} m/s`,
            column.cloud === null || column.cloud === undefined
                ? null
                : `Cloud ${Math.round(column.cloud)}%`,
            column.shade === null ? null : `Shade ${Math.round(column.shade * 100)}%`,
            column.cloudBase === null ? null : `Base ${Math.round(column.cloudBase).toLocaleString()} m`,
            ...winds
        ].filter(Boolean);

        // Flipped to the other side of the crosshair before it would run off
        // the drawing.
        const flip = x > (this.left + this.right) / 2;
        const anchor = flip ? 'end' : 'start';
        const offset = flip ? -8 : 8;

        this.valueLayer.innerHTML = lines.map((line, row) => `
            <text class="windgram-readout-line" x="${(x + offset).toFixed(1)}"
                  y="${this.top + 14 + row * 13}" text-anchor="${anchor}">${escape(line)}</text>`).join('');

        reveal(this.readout, true);
    }

    /**
     * @returns {void}
     */
    hideReadout() {
        reveal(this.readout, false);
    }
}
