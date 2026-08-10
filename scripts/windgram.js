import {
    LAYOUT, STRIPS, BARB_SPACING, COLUMN_MS, EXTRAPOLATED_OPACITY
} from './config/rasp.js';
import {LAPSE} from './config/bands.js';
import {FEET} from './rasp.js';
import {barbPath, CALM} from './lib/barb.js';
import {escape} from './lib/markup.js';

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
     * @param {HTMLElement} host - The element the drawing goes into
     */
    constructor(host) {
        this.host = host;
        this.model = null;

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
     * Draws at whatever size the container currently is.
     * @returns {void}
     */
    draw() {
        const width = Math.round(this.host.clientWidth);

        // A hidden panel has no width; it will be drawn when it is shown.
        if (!width) return;

        if (!this.model?.columns?.length) {
            this.host.innerHTML =
                '<p class="chart-empty">Not enough logged today to draw the profile yet.</p>';
            return;
        }

        this.left = LAYOUT.left;
        this.right = width - LAYOUT.right;

        const strips = STRIPS.length * (LAYOUT.strip + LAYOUT.stripGap);
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
            </svg>`;

        this.svg = this.host.querySelector('.windgram-svg');
        this.readout = this.host.querySelector('.windgram-readout');
        this.crosshair = this.host.querySelector('.windgram-crosshair');
        this.valueLayer = this.host.querySelector('.windgram-values');
    }

    /**
     * The hatch the drawing marks cloud with, and the clip that keeps the
     * coloured slabs inside the panel.
     * @returns {string} SVG markup
     */
    defs() {
        return `<defs>
            <pattern id="windgram-cloud" width="7" height="7" patternUnits="userSpaceOnUse"
                     patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(30,58,138,.35)" stroke-width="2.2"></line>
            </pattern>
            <pattern id="windgram-missing" width="8" height="8" patternUnits="userSpaceOnUse"
                     patternTransform="rotate(-45)">
                <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(22,32,43,.10)" stroke-width="3"></line>
            </pattern>
            <clipPath id="windgram-panel">
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
        return Math.max(1, this.x(this.model.dayStart + COLUMN_MS) - this.x(this.model.dayStart));
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
        return STRIPS.map((strip, index) => {
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
                               d="M${run[0].x.toFixed(1)} ${bottom.toFixed(1)}`
                    + run.map(point => `L${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join('')
                    + `L${run.at(-1).x.toFixed(1)} ${bottom.toFixed(1)}Z"></path>`;

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
            <g clip-path="url(#windgram-panel)">
                ${this.renderMissing()}
                ${this.renderStability()}
                ${this.renderCloud()}
                ${this.renderTerrain()}
                ${this.renderIsotherms()}
                ${this.renderThermalTop()}
                ${this.renderCloudBase()}
                ${this.renderBarbs()}
            </g>
            <rect class="windgram-frame" x="${this.left}" y="${this.top}"
                  width="${this.right - this.left}" height="${this.bottom - this.top}"></rect>
        </g>`;
    }

    /**
     * The coloured air. One rectangle per slab per column, in the same palette
     * the lapse tag and the live overlay use.
     * @returns {string} SVG markup
     */
    renderStability() {
        const width = this.columnWidth();

        const cells = this.model.columns.map(column => {
            const x = this.x(column.time) - width / 2;

            return [...column.segments, column.above].filter(Boolean).map(slab => {
                const colour = slab.band?.color;
                if (!colour) return '';

                const top = this.y(slab.to);
                const height = this.y(slab.from) - top;

                // Half a pixel of overlap, or antialiasing draws a pale seam
                // between every pair of columns.
                return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}"
                              width="${(width + 0.6).toFixed(1)}" height="${Math.max(0, height).toFixed(1)}"
                              fill="${colour}"${
                                  slab.extrapolated ? ` opacity="${EXTRAPOLATED_OPACITY}"` : ''}></rect>`;
            }).join('');
        }).join('');

        // The line above which nothing was measured. Without it the faded air
        // reads as haze rather than as the edge of what we know.
        const top = this.model.stations.at(-1)?.elevation;

        const boundary = top === undefined ? '' : `
            <line class="windgram-extrapolated-edge" x1="${this.left}" x2="${this.right}"
                  y1="${this.y(top).toFixed(1)}" y2="${this.y(top).toFixed(1)}"></line>`;

        return `<g class="windgram-stability">${cells}${boundary}</g>`;
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
                          fill="url(#windgram-missing)"></rect>`;
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
                              fill="url(#windgram-cloud)"></rect>`;
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
                const d = run.map((point, index) =>
                    `${index ? 'L' : 'M'}${this.x(point.time).toFixed(1)} ${this.y(point.elevation).toFixed(1)}`
                ).join('');

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

        const d = points.map((point, index) =>
            `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join('');

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
     * Where a thermal would condense, if it got that far.
     * @returns {string} SVG markup
     */
    renderCloudBase() {
        const points = this.model.columns
            .filter(column => column.cloudBase !== null)
            .map(column => ({x: this.x(column.time), y: this.y(column.cloudBase)}));

        if (points.length < 2) return '';

        const d = points.map((point, index) =>
            `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join('');

        return `<path class="windgram-cloudbase" d="${d}"></path>`;
    }

    /**
     * A row of barbs at each station's own height.
     *
     * Only three rows, because only three heights were measured. Filling the
     * panel with interpolated barbs would look more like the forecast it is
     * modelled on and mean considerably less.
     *
     * @returns {string} SVG markup
     */
    renderBarbs() {
        const columns = this.model.columns;
        const perColumn = (this.right - this.left) / Math.max(columns.length, 1);
        const step = Math.max(1, Math.round(BARB_SPACING / Math.max(perColumn, 1)));

        let marks = '';

        for (let index = Math.floor(step / 2); index < columns.length; index += step) {
            const column = columns[index];
            const x = this.x(column.time);

            column.levels.forEach(level => {
                if (level.windDir === null || level.windSpeed === null) return;

                const y = this.y(level.elevation);
                const at = `${x.toFixed(1)} ${y.toFixed(1)}`;

                if (level.windSpeed < CALM) {
                    marks += `<circle class="windgram-calm" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"></circle>`;
                    return;
                }

                // The shaft is drawn pointing up and turned to the bearing the
                // wind is coming from, which is what the reading names.
                marks += `<path class="windgram-barb" d="${barbPath(level.windSpeed)}"
                                transform="translate(${at}) rotate(${level.windDir.toFixed(0)})"></path>`;
            });
        }

        return `<g class="windgram-barbs">${marks}</g>`;
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
        const from = Math.ceil((dayStart - dayStart) / HOUR);

        let marks = '';

        for (let hour = from; hour <= hours; hour += step) {
            const x = this.x(dayStart + hour * HOUR);

            marks += `<line class="windgram-hour-tick" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}"
                            y1="${this.bottom}" y2="${this.bottom + 4}"></line>
                      <text class="windgram-axis" x="${x.toFixed(1)}" y="${this.bottom + 17}"
                            text-anchor="middle">${String(hour).padStart(2, '0')}</text>`;
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
        const zone = this.model.offset === undefined
            ? ''
            : ` (UTC${this.model.offset > 0 ? '+' : '−'}${Math.abs(Math.round(this.model.offset / HOUR))})`;

        const launch = this.model.launch?.shortName ?? 'launch';
        const top = this.model.stations.at(-1)?.shortName ?? 'the top station';

        const sentences = [
            `Local lapse rate in ºC per 1000 ft. Wind barbs in km/h. Time${zone}.`,
            'Blue hatching is air within half a degree of its dew point; grey hatching is air no station was reporting from.',
            `* Shade is how much of the clear-sky sunlight is missing — cloud, haze or terrain. Lift is worked out from that and the measured profile, not sensed, with thermals released from ${launch}. Air above ${top} is extrapolated.`
        ];

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
     * Reading off a column: a crosshair, and the numbers behind that moment.
     * Bound once to the host, so redrawing never has to rebind it.
     * @returns {void}
     */
    bindPointer() {
        const move = event => {
            if (!this.svg || !this.model) return;

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
        this.host.addEventListener('pointerleave', () => this.hideReadout());
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

        const lines = [
            clock,
            column.thermalTop === null
                ? 'No thermal'
                : `Top ${Math.round(column.thermalTop).toLocaleString()} m`,
            column.lift === null ? null : `Lift ${column.lift.toFixed(1)} m/s`,
            column.shade === null ? null : `Shade ${Math.round(column.shade * 100)}%`,
            column.cloudBase === null ? null : `Base ${Math.round(column.cloudBase).toLocaleString()} m`
        ].filter(Boolean);

        // Flipped to the other side of the crosshair before it would run off
        // the drawing.
        const flip = x > (this.left + this.right) / 2;
        const anchor = flip ? 'end' : 'start';
        const offset = flip ? -8 : 8;

        this.valueLayer.innerHTML = lines.map((line, row) => `
            <text class="windgram-readout-line" x="${(x + offset).toFixed(1)}"
                  y="${this.top + 14 + row * 13}" text-anchor="${anchor}">${escape(line)}</text>`).join('');

        this.readout.hidden = false;
    }

    /**
     * @returns {void}
     */
    hideReadout() {
        if (this.readout) this.readout.hidden = true;
    }
}
