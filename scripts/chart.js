import {SERIES} from './config/series.js';
import {nearestIndex} from './lib/series-time.js';
import {reveal} from './lib/reveal.js';

/**
 * The day's readings, drawn.
 *
 * Separate mode is the shape Weather Underground uses, and for the same reason:
 * each measurement gets a panel and a real axis, with the ones that belong
 * together — temperature and dew point, wind and its gusts, rain total and rain
 * rate — sharing a panel so they can be read against each other. All the panels
 * share one row of hours, and one crosshair reads every panel at once.
 *
 * Overlay mode puts the selected measurements on a single pair of axes, for
 * looking for a correlation rather than a value. Series that share a unit share
 * an axis. Beyond two units there is no honest shared scale, so each line is
 * traced across its own range and the chart says so: the shapes still line up
 * in time, which is what a correlation is.
 */

// Room for the axes and the hour labels.
const PAD = {top: 14, right: 14, bottom: 42, left: 46};
const AXIS_WIDTH = 46;

const COMBINED_HEIGHT = 250;
const PANEL_HEIGHT = 104;

// Enough for the hours under the last panel and the legend under each of the
// others, so a panel's own labels never sit on the panel below.
const PANEL_GAP = 38;

// Below this the hour labels collide, so they thin out.
const NARROW = 520;

// How close two readout labels may sit before they are nudged apart.
const LABEL_GAP = 13;

// A crosshair further than this from a reading has nothing to report.
const HOVER_TOLERANCE = 15 * 60 * 1000;

// The compass, down the right of the wind direction panel.
const COMPASS = [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W'], [360, 'N']];

// Headroom above a panel carrying the row of wind arrows.
const ARROW_BAND = 24;

// Roughly how far apart the arrows sit. Any closer and they overlap; any
// further and the sweep of a veering wind stops being visible.
const ARROW_SPACING = 42;

/**
 * Round numbers for an axis, chosen from the data's own range.
 * @param {number} min - Lowest value
 * @param {number} max - Highest value
 * @param {number} [target=4] - Roughly how many ticks to aim for
 * @returns {Object} ticks, and the padded lo/hi they span
 */
function niceScale(min, max, target = 4, floor = null) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return {ticks: [0, 1], lo: 0, hi: 1};

    // A flat line still needs an axis with height, or it divides by zero.
    if (max - min < 1e-9) {
        const pad = Math.abs(max) > 1 ? Math.abs(max) * 0.05 : 0.5;
        min -= pad;
        max += pad;
    }

    const raw = (max - min) / target;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(candidate => candidate >= raw)
        ?? 10 * magnitude;

    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];

    // Guard the loop against floating point drift rather than trusting <=.
    for (let value = lo; value <= hi + step / 1000; value += step) {
        ticks.push(Number(value.toFixed(10)));
    }

    // Some measurements have no meaning below a bound — rain, sunlight and
    // wind speed cannot be negative — so the axis stops there rather than
    // padding into numbers that could never be reported.
    if (floor !== null && lo < floor) {
        return {ticks: ticks.filter(tick => tick >= floor), lo: floor, hi};
    }

    return {ticks, lo, hi};
}

/**
 * Trims an axis label so a scale in hundredths does not print six digits.
 * @param {number} value - A tick value
 * @returns {string} The label
 */
function tickLabel(value) {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * Escapes text bound for markup.
 * @param {string} value - Raw text
 * @returns {string} Text safe to interpolate
 */
function escape(value) {
    return String(value).replace(/[&<>"]/g, character =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[character]);
}

export class Chart {
    /**
     * @param {HTMLElement} host - The element the chart draws into
     */
    constructor(host) {
        this.host = host;
        this.day = null;
        this.selected = [];
        this.mode = 'split';
        this.catalogue = SERIES;
        this.plots = [];

        this.redraw = () => this.draw();

        // The chart is sized from its container, so it has to be redrawn when
        // that container changes: a rotation, a resize, or the panel it lives
        // in being shown for the first time.
        if (typeof ResizeObserver !== 'undefined') {
            this.observer = new ResizeObserver(() => this.scheduleDraw());
            this.observer.observe(host);
        } else {
            window.addEventListener('resize', this.redraw);
        }

        this.bindPointer();
    }

    /**
     * Stops observing, for a chart whose panel is being replaced.
     * @returns {void}
     */
    destroy() {
        this.observer?.disconnect();
        window.removeEventListener('resize', this.redraw);
        cancelAnimationFrame(this.frame);
    }

    /**
     * Coalesces the redraws a resize fires in bursts.
     * @returns {void}
     */
    scheduleDraw() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(this.redraw);
    }

    /**
     * @param {?Object} day - A day from the history reader
     * @returns {void}
     */
    setDay(day) {
        this.day = day;
        this.draw();
    }

    /**
     * When the sun rose and set over this station, so the day can be marked on
     * the chart rather than only named above it.
     *
     * Stored rather than drawn, like the catalogue: the caller sets this before
     * the view, and setting the view is what redraws.
     *
     * @param {?Object} sun - sunrise and sunset, in milliseconds
     * @returns {void}
     */
    setSun(sun) {
        this.sun = sun;
    }

    /**
     * The measurements this chart may draw. Defaults to the ones a station
     * records; the page adds the lapse rates it works out between stations.
     * @param {Object[]} catalogue - Series definitions
     * @returns {void}
     */
    setCatalogue(catalogue) {
        this.catalogue = catalogue;
    }

    /**
     * @param {string[]} keys - The measurements to show
     * @param {string} mode - "split" or "combined"
     * @returns {void}
     */
    setView(keys, mode) {
        this.selected = keys;
        this.mode = mode;
        this.draw();
    }

    /**
     * The selected measurements that this station actually reports.
     * @returns {Object[]} Series definitions, in the order they are offered
     */
    activeSeries() {
        return this.catalogue.filter(series =>
            this.selected.includes(series.key)
            && this.day?.values?.[series.key]?.some(value => value !== null));
    }

    /**
     * Draws the chart at whatever size its container currently is.
     * @returns {void}
     */
    draw() {
        const width = Math.round(this.host.clientWidth);

        // A hidden panel has no width; it will be drawn when it is shown.
        if (!width) return;

        if (!this.day) {
            this.host.innerHTML = '<p class="chart-empty">No readings logged for today yet.</p>';
            return;
        }

        const series = this.activeSeries();

        if (!series.length) {
            this.host.innerHTML = '<p class="chart-empty">Pick a measurement to plot.</p>';
            return;
        }

        this.plots = this.mode === 'combined'
            ? this.layoutCombined(series, width)
            : this.layoutSplit(series, width);

        const height = this.plots.at(-1).bottom + PAD.bottom;

        this.host.innerHTML = `
            <svg class="chart-svg" width="${width}" height="${height}"
                 viewBox="0 0 ${width} ${height}" role="img"
                 aria-label="${escape(series.map(item => item.label).join(', '))} through today">
                ${this.plots.map(plot => this.renderPlot(plot)).join('')}
                ${this.renderSun()}
                ${this.renderHours(width)}
                <g class="chart-readout" hidden>
                    <line class="chart-crosshair" y1="${PAD.top - 4}" y2="${this.plots.at(-1).bottom}"></line>
                    <g class="chart-values"></g>
                </g>
            </svg>`;

        this.svg = this.host.querySelector('.chart-svg');
        this.readout = this.host.querySelector('.chart-readout');
        this.crosshair = this.host.querySelector('.chart-crosshair');
        this.valueLayer = this.host.querySelector('.chart-values');

        this.reflowLegends();
    }

    /**
     * Sunrise and sunset, ruled down the whole stack.
     *
     * One line each rather than one per plot: the reader is being shown a
     * moment, and a moment is the same moment on every panel. Drawn over the
     * data rather than under it, which is why they are thin, dashed and grey —
     * the day's bounds are the frame around the readings, not another reading.
     *
     * @returns {string} SVG markup
     */
    renderSun() {
        if (!this.plots.length || !this.day) return '';

        const first = this.plots[0];
        const last = this.plots.at(-1);

        return [
            {at: this.sun?.sunrise, label: 'Sunrise'},
            {at: this.sun?.sunset, label: 'Sunset'}
        ]
            // A day above the arctic circle has neither, and a sunset can fall
            // past the end of the axis at the far north in summer.
            .filter(mark => Number.isFinite(mark.at)
                && mark.at >= this.day.dayStart && mark.at <= this.day.dayEnd)
            .map(mark => {
                const x = this.x(mark.at, first);

                // Flipped before the label would run off the right-hand edge.
                const flip = x > (first.left + first.right) / 2;

                return `<g class="chart-sun">
                    <line class="chart-sun-line" x1="${x.toFixed(1)}" y1="${first.top}"
                          x2="${x.toFixed(1)}" y2="${last.bottom}"></line>
                    <text class="chart-sun-label" x="${(x + (flip ? -4 : 4)).toFixed(1)}"
                          y="${(first.top - 4).toFixed(1)}"
                          text-anchor="${flip ? 'end' : 'start'}">${mark.label}</text>
                </g>`;
            }).join('');
    }

    /**
     * Everything on one pair of axes.
     *
     * Series are banked by unit. One or two units get a real axis each — left
     * and right — and are read off directly. Three or more have no shared scale
     * worth drawing, so each line is traced across its own range instead.
     *
     * @param {Object[]} series - The selected series
     * @param {number} width - Available width
     * @returns {Object[]} A single plot
     */
    layoutCombined(series, width) {
        const units = [...new Set(series.map(item => item.unit))];
        const relative = units.length > 2;
        const right = units.length === 2 ? AXIS_WIDTH : PAD.right;

        const axes = relative ? [] : units.map((unit, index) => ({
            unit,
            side: index === 0 ? 'left' : 'right',
            ...this.scaleFor(series.filter(item => item.unit === unit))
        }));

        // Direction is hard to read off a wrapping axis, and impossible to read
        // off one shared with four other measurements. The arrows say it
        // outright, so they come along whenever direction is being shown.
        const arrows = series.some(item => item.key === 'windDir');
        const top = PAD.top + (arrows ? ARROW_BAND : 0);

        return [{
            left: PAD.left,
            right: width - right,
            top,
            bottom: top + COMBINED_HEIGHT,
            series,
            axes,
            relative,
            arrows,
            legend: series.length > 1
        }];
    }

    /**
     * A panel per group of measurements, stacked, sharing the hours along the
     * bottom. The groups are the ones that belong together: temperature with
     * dew point, wind with its gusts, rain total with rain rate.
     * @param {Object[]} series - The selected series
     * @param {number} width - Available width
     * @returns {Object[]} One plot per group
     */
    layoutSplit(series, width) {
        const groups = [];

        series.forEach(item => {
            const name = item.group ?? item.key;
            const existing = groups.find(group => group.name === name);

            if (existing) {
                existing.series.push(item);
            } else {
                groups.push({name, series: [item]});
            }
        });

        // Stacked down the page rather than placed by index, because the wind
        // direction panel claims a band above itself for its arrows and every
        // panel below it has to move down by the same amount.
        let cursor = PAD.top;

        return groups.map(group => {
            const compass = group.series.some(item => item.key === 'windDir');
            const top = cursor + (compass ? ARROW_BAND : 0);
            cursor = top + PANEL_HEIGHT + PANEL_GAP;

            return {
                left: PAD.left,
                right: width - (compass ? AXIS_WIDTH / 2 : PAD.right),
                top,
                bottom: top + PANEL_HEIGHT,
                series: group.series,
                // A group is one unit by construction, so one axis serves it.
                axes: [{unit: group.series[0].unit, side: 'left', ...this.scaleFor(group.series)}],
                relative: false,
                compass,
                arrows: compass,
                legend: true
            };
        });
    }

    /**
     * The value range shared by a bank of series measured in the same unit.
     * @param {Object[]} series - Series sharing one unit
     * @returns {Object} lo, hi and the ticks between them
     */
    scaleFor(series) {
        // A measurement with a natural range — a compass — keeps it, so a
        // steady wind reads as steady rather than filling the panel.
        // A bank counts as inverted only when every series in it is.
        const invert = series.every(item => item.invert === true);

        const fixed = series.find(item => item.domain);
        if (fixed) {
            const [lo, hi] = fixed.domain;
            return {lo, hi, invert, ticks: [0, 90, 180, 270, 360].filter(tick => tick >= lo && tick <= hi)};
        }

        const values = series
            .flatMap(item => this.day.values[item.key] ?? [])
            .filter(value => value !== null);

        if (!values.length) return {lo: 0, hi: 1, invert, ticks: [0, 1]};

        // A bank shares a floor only when every series in it has one.
        const floors = series.map(item => item.floor);
        const floor = floors.every(value => Number.isFinite(value)) ? Math.max(...floors) : null;

        return {...niceScale(Math.min(...values), Math.max(...values), 4, floor), invert};
    }

    /**
     * Where a moment sits across the plot. The domain is the whole local day,
     * so a station that started late begins partway in rather than being
     * stretched to fill the width.
     * @param {number} time - Milliseconds
     * @param {Object} plot - The plot being drawn
     * @returns {number} An x coordinate
     */
    x(time, plot) {
        const span = this.day.dayEnd - this.day.dayStart;
        return plot.left + ((time - this.day.dayStart) / span) * (plot.right - plot.left);
    }

    /**
     * Where a value sits up the plot, on whichever scale governs its series.
     * @param {number} value - The reading
     * @param {Object} series - Its series definition
     * @param {Object} plot - The plot being drawn
     * @returns {number} A y coordinate
     */
    y(value, series, plot) {
        const scale = plot.relative
            ? this.scaleFor([series])
            : plot.axes.find(axis => axis.unit === series.unit) ?? plot.axes[0];

        return this.atValue(value, scale, plot);
    }

    /**
     * Where a value sits up a plot on a given axis.
     * @param {number} value - The value
     * @param {Object} axis - The axis it is measured on
     * @param {Object} plot - The plot being drawn
     * @returns {number} A y coordinate
     */
    atValue(value, axis, plot) {
        const fraction = (value - axis.lo) / (axis.hi - axis.lo);

        // An inverted axis counts down from the top. Lapse rate is the one that
        // wants it: the more negative the number, the more the air climbs, so
        // the reading a pilot is looking for belongs at the top of the panel.
        return axis.invert
            ? plot.top + fraction * (plot.bottom - plot.top)
            : plot.bottom - fraction * (plot.bottom - plot.top);
    }

    /**
     * One plot: its gridlines, its axes, its lines and its legend.
     * @param {Object} plot - A plot from the layout
     * @returns {string} SVG markup
     */
    renderPlot(plot) {
        const primary = plot.axes[0];

        // Three-hour bands behind the plot. They carry no data; they make a
        // time readable off the chart without tracing down to the axis.
        let bands = '';
        for (let hour = 0; hour < 24; hour += 3) {
            if ((hour / 3) % 2) continue;

            const from = this.x(this.day.dayStart + hour * 3600000, plot);
            const to = this.x(this.day.dayStart + (hour + 3) * 3600000, plot);

            bands += `<rect class="chart-band" x="${from.toFixed(1)}" y="${plot.top}"
                            width="${(to - from).toFixed(1)}" height="${plot.bottom - plot.top}"
                            fill="rgba(22, 32, 43, .04)"></rect>`;
        }

        // With no shared scale there is nothing to label, but the plot still
        // needs horizontal rules to read heights against.
        const gridlines = (primary?.ticks ?? [0, 0.25, 0.5, 0.75, 1]).map(tick => {
            const y = primary
                ? this.atValue(tick, primary, plot)
                : plot.bottom - tick * (plot.bottom - plot.top);

            return `<line class="chart-grid" x1="${plot.left}" y1="${y.toFixed(1)}" x2="${plot.right}" y2="${y.toFixed(1)}"></line>`;
        }).join('');

        const axisLabels = plot.axes.map(axis => axis.ticks.map(tick => {
            const y = this.atValue(tick, axis, plot);
            const onLeft = axis.side === 'left';

            return `<text class="chart-axis" x="${onLeft ? plot.left - 8 : plot.right + 8}" y="${(y + 4).toFixed(1)}"
                          text-anchor="${onLeft ? 'end' : 'start'}">${tickLabel(tick)}</text>`;
        }).join('')).join('');

        const units = plot.relative
            ? `<text class="chart-unit" x="${plot.left - 8}" y="${plot.top - 4}" text-anchor="end">rel.</text>`
            : plot.axes.filter(axis => axis.unit).map(axis => {
                const onLeft = axis.side === 'left';

                return `<text class="chart-unit" x="${onLeft ? plot.left - 8 : plot.right + 8}" y="${plot.top - 4}"
                              text-anchor="${onLeft ? 'end' : 'start'}">${escape(axis.unit)}</text>`;
            }).join('');

        // The compass reads a bearing off the direction panel without doing
        // arithmetic on the degrees down the other side.
        const compass = plot.compass
            ? COMPASS.map(([degrees, point]) => {
                const y = plot.bottom - (degrees / 360) * (plot.bottom - plot.top);
                return `<text class="chart-axis" x="${plot.right + 6}" y="${(y + 4).toFixed(1)}">${point}</text>`;
            }).join('')
            : '';

        // Sign is the whole story for a lapse rate — cooling with height above
        // the line, an inversion below it — so zero is drawn darker.
        const zero = primary && primary.lo < 0 && primary.hi > 0
            ? `<line class="chart-zero" x1="${plot.left}" x2="${plot.right}"
                     y1="${this.atValue(0, primary, plot).toFixed(1)}"
                     y2="${this.atValue(0, primary, plot).toFixed(1)}"></line>`
            : '';

        return `<g>
            ${bands}
            ${gridlines}
            ${zero}
            ${axisLabels}
            ${units}
            ${compass}
            ${plot.arrows ? this.renderArrows(plot) : ''}
            ${plot.series.map(series => this.renderSeries(series, plot)).join('')}
            ${plot.legend ? this.renderLegend(plot) : ''}
        </g>`;
    }

    /**
     * A row of arrows above the plot, each pointing the way the wind was going.
     *
     * Dots on a 0–360 axis say where the wind was, but reading them means
     * converting a number back into a direction, and the wrap at north makes a
     * steady wind look like it is swinging. An arrow needs no conversion: a
     * whole afternoon of veering reads at a glance.
     *
     * They are sampled evenly across the day rather than drawn per reading —
     * one per reading would be a smear — and each takes the reading nearest its
     * own slot, so a gap in the log leaves a gap in the row.
     *
     * The glyph is the one the wind tiles use, turned the same way: the reading
     * names the direction the wind blows *from*, so the arrow points 180
     * degrees away from it.
     *
     * @param {Object} plot - The plot being drawn
     * @returns {string} SVG markup
     */
    renderArrows(plot) {
        const column = this.day.values.windDir;
        if (!column) return '';

        const colour = this.catalogue.find(series => series.key === 'windDir')?.colour ?? 'currentColor';
        const count = Math.max(2, Math.floor((plot.right - plot.left) / ARROW_SPACING));
        const span = this.day.dayEnd - this.day.dayStart;
        const slot = span / count;
        const y = plot.top - ARROW_BAND / 2;

        let marks = '';

        for (let i = 0; i < count; i++) {
            // The middle of this slot, so the row sits inside the plot rather
            // than hanging an arrow off each end.
            const time = this.day.dayStart + (i + 0.5) * slot;
            const index = nearestIndex(this.day.times, time);

            if (index === -1) continue;

            // Nothing logged anywhere near this slot: leave it empty rather
            // than reaching across the gap for a direction from hours away.
            if (Math.abs(this.day.times[index] - time) > slot / 2) continue;

            const degrees = column[index];
            if (degrees === null) continue;

            const x = plot.left + ((time - this.day.dayStart) / span) * (plot.right - plot.left);
            const at = `${x.toFixed(1)} ${y.toFixed(1)}`;

            marks += `<text class="chart-arrow" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
                            text-anchor="middle" dominant-baseline="central" fill="${colour}"
                            transform="rotate(${(degrees + 180).toFixed(1)} ${at})">navigation</text>`;
        }

        // Decorative: every one of these is a reading already plotted below,
        // and a screen reader announcing twenty arrow glyphs helps nobody.
        return `<g class="chart-arrows" aria-hidden="true">${marks}</g>`;
    }

    /**
     * The key under a panel, naming each line by its colour.
     * @param {Object} plot - The plot being drawn
     * @returns {string} SVG markup
     */
    renderLegend(plot) {
        const y = plot.bottom + 17;

        // Laid out at nought and spaced properly once the text can be measured;
        // guessing a label's width from its character count collides the moment
        // the font is not the one that was guessed for.
        return `<g class="chart-key-group" data-left="${plot.left}" data-y="${y}">${
            plot.series.map(series => `
                <g class="chart-key-entry">
                    <rect class="chart-key-swatch" y="${y - 7}" width="9" height="9" rx="2" fill="${series.colour}"></rect>
                    <text class="chart-key" y="${y}">${escape(
                        `${series.label}${series.unit ? ` (${series.unit})` : ''}`)}</text>
                </g>`).join('')
        }</g>`;
    }

    /**
     * Spaces each key by the width its label actually takes, wrapping onto a
     * second row rather than running off the side of a narrow chart.
     * @returns {void}
     */
    reflowLegends() {
        const width = this.svg.viewBox.baseVal.width;
        let extra = 0;

        this.svg.querySelectorAll('.chart-key-group').forEach(group => {
            const left = Number(group.dataset.left);
            let x = left;
            let row = 0;

            group.querySelectorAll('.chart-key-entry').forEach(entry => {
                const swatch = entry.querySelector('rect');
                const text = entry.querySelector('text');
                const span = 13 + text.getComputedTextLength() + 16;

                if (x > left && x + span > width) {
                    row += 1;
                    x = left;
                }

                const y = Number(group.dataset.y) + row * 14;
                swatch.setAttribute('x', x);
                swatch.setAttribute('y', y - 7);
                text.setAttribute('x', x + 13);
                text.setAttribute('y', y);
                x += span;
            });

            extra = Math.max(extra, row * 14);
        });

        // A wrapped key needs the room it took, and the hours have to move down
        // by the same amount or the two print over each other.
        if (extra) {
            const height = this.svg.viewBox.baseVal.height + extra;
            this.svg.setAttribute('height', height);
            this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
            this.svg.querySelector('.chart-hours')?.setAttribute('transform', `translate(0 ${extra})`);
        }
    }

    /**
     * One measurement's trace. Gaps in the data break the line rather than
     * being bridged, so an outage looks like an outage.
     * @param {Object} series - The series definition
     * @param {Object} plot - The plot being drawn
     * @returns {string} SVG markup
     */
    renderSeries(series, plot) {
        const column = this.day.values[series.key];
        const times = this.day.times;

        if (series.shape === 'dots') {
            return `<g class="chart-dots" fill="${series.colour}">${
                column.map((value, index) => value === null
                    ? ''
                    : `<circle cx="${this.x(times[index], plot).toFixed(1)}" cy="${this.y(value, series, plot).toFixed(1)}" r="1.6"></circle>`
                ).join('')
            }</g>`;
        }

        let path = '';
        let drawing = false;

        column.forEach((value, index) => {
            if (value === null) {
                drawing = false;
                return;
            }

            const point = `${this.x(times[index], plot).toFixed(1)} ${this.y(value, series, plot).toFixed(1)}`;
            path += drawing ? `L${point}` : `M${point}`;
            drawing = true;
        });

        // fill and width are stated on the element as well as in the stylesheet:
        // an unstyled path is filled black by default, which turns a day's
        // temperature into a solid wedge.
        return `<path class="chart-line" d="${path}" stroke="${series.colour}"
                      fill="none" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></path>`;
    }

    /**
     * The hours along the bottom, shared by every panel. They thin out on a
     * narrow screen rather than overlapping into an unreadable band.
     * @param {number} width - Chart width
     * @returns {string} SVG markup
     */
    renderHours(width) {
        const step = width < NARROW ? 6 : 3;
        const plot = this.plots[0];
        const baseline = this.plots.at(-1).bottom;
        let marks = '';

        for (let hour = 0; hour <= 24; hour += step) {
            const x = this.x(this.day.dayStart + hour * 3600000, plot);
            const label = hour === 0 || hour === 24 ? '12a'
                : hour === 12 ? '12p'
                : hour < 12 ? `${hour}a` : `${hour - 12}p`;

            marks += `<text class="chart-axis" x="${x.toFixed(1)}" y="${baseline + 34}" text-anchor="middle">${label}</text>`;
        }

        return `<g class="chart-hours">
            <line class="chart-baseline" x1="${plot.left}" y1="${baseline}" x2="${plot.right}" y2="${baseline}"></line>
            ${marks}
        </g>`;
    }

    /**
     * Reading off a moment: one crosshair down every panel, with each line's
     * value printed beside where the crosshair crosses it. Bound once to the
     * host, so redrawing the chart never has to rebind it.
     * @returns {void}
     */
    bindPointer() {
        const move = event => {
            if (!this.svg || !this.day) return;

            const box = this.svg.getBoundingClientRect();
            // The SVG is drawn at its own pixel size, but a zoomed page still
            // scales it, so client pixels are converted before they are used.
            const scale = box.width / this.svg.viewBox.baseVal.width;
            const x = (event.clientX - box.left) / scale;
            const plot = this.plots[0];

            if (x < plot.left - 4 || x > plot.right + 4) return this.hideReadout();

            const span = this.day.dayEnd - this.day.dayStart;
            const time = this.day.dayStart + ((x - plot.left) / (plot.right - plot.left)) * span;
            const index = nearestIndex(this.day.times, time);

            // Past the last reading of the day there is nothing to report.
            if (index === -1 || Math.abs(this.day.times[index] - time) > HOVER_TOLERANCE) {
                return this.hideReadout();
            }

            this.showReadout(index);
        };

        this.host.addEventListener('pointermove', move);
        this.host.addEventListener('pointerdown', move);
        this.host.addEventListener('pointerleave', () => this.hideReadout());
    }

    /**
     * Prints every selected reading at one moment, panel by panel.
     * @param {number} index - The reading's position in the day
     * @returns {void}
     */
    showReadout(index) {
        const time = this.day.times[index];
        const x = this.x(time, this.plots[0]);
        const width = this.svg.viewBox.baseVal.width;

        this.crosshair.setAttribute('x1', x.toFixed(1));
        this.crosshair.setAttribute('x2', x.toFixed(1));

        const clock = new Date(time).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});

        // Labels sit to the right of the crosshair until that would run them
        // off the chart, then they swap to the left of it.
        const flip = x > width * 0.72;
        const anchor = flip ? 'end' : 'start';
        const offset = flip ? -7 : 7;

        let markup = `<text class="chart-readout-time" x="${(x + offset).toFixed(1)}" y="${PAD.top - 5}"
                            text-anchor="${anchor}">${escape(clock)}</text>`;

        this.plots.forEach(plot => {
            markup += this.renderPlotValues(plot, index, x + offset, anchor);
        });

        this.valueLayer.innerHTML = markup;
        reveal(this.readout, true);
    }

    /**
     * One panel's values at a moment, nudged apart so two lines that meet do
     * not print their labels on top of each other.
     * @param {Object} plot - The plot being read
     * @param {number} index - The reading's position in the day
     * @param {number} x - Where the labels start
     * @param {string} anchor - Text anchor, start or end
     * @returns {string} SVG markup
     */
    /**
     * One reading, written the way that measurement is read.
     *
     * Most are a number and a unit. A bearing is not: "224.0 º" has to be
     * converted back into a direction before it means anything, and the rest of
     * the site — the tile, the arrows, the compass down the side of this very
     * panel — all say WSW. A series says so by carrying its own `format`.
     *
     * @param {number} value - The reading
     * @param {Object} series - Its series definition
     * @returns {string} The reading, as words
     */
    readingText(value, series) {
        if (series.format) return series.format(value);

        return `${value.toFixed(series.digits ?? 1)}${series.unit ? ` ${series.unit}` : ''}`;
    }

    renderPlotValues(plot, index, x, anchor) {
        const entries = plot.series
            .map(series => {
                const value = this.day.values[series.key][index];
                if (value === null) return null;

                return {
                    series,
                    y: this.y(value, series, plot),
                    text: this.readingText(value, series)
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.y - b.y);

        // One pass down, then a clamp back up, keeps the block inside the panel
        // even when every line is bunched at the top of it.
        entries.forEach((entry, position) => {
            entry.y = Math.max(entry.y, plot.top + 8);
            if (position > 0) entry.y = Math.max(entry.y, entries[position - 1].y + LABEL_GAP);
        });

        const overshoot = (entries.at(-1)?.y ?? 0) - plot.bottom;
        if (overshoot > 0) entries.forEach(entry => { entry.y -= overshoot; });

        return entries.map(entry => `
            <circle class="chart-readout-dot" cx="${this.x(this.day.times[index], plot).toFixed(1)}"
                    cy="${this.y(this.day.values[entry.series.key][index], entry.series, plot).toFixed(1)}"
                    r="3" fill="${entry.series.colour}"></circle>
            <text class="chart-readout-value" x="${x.toFixed(1)}" y="${(entry.y + 4).toFixed(1)}"
                  text-anchor="${anchor}" fill="${entry.series.colour}">${escape(entry.text)}</text>`).join('');
    }

    /**
     * @returns {void}
     */
    hideReadout() {
        reveal(this.readout, false);
    }
}
