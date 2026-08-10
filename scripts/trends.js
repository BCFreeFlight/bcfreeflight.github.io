import history, {SERIES} from './history.js';
import {Chart} from './chart.js';
import {lapsePairs, lapseColumn} from './lapse-series.js';

/**
 * The day's readings, as a panel.
 *
 * One of these sits under each station's tiles. It owns the chips, the layout
 * choice, and the chart itself. Which measurements are showing is remembered
 * across stations and across visits, because someone who came to watch wind
 * against temperature wants that same pair on the next station and the next
 * morning.
 *
 * Every station's day is read together rather than tab by tab, because lapse
 * rate is worked out between stations: the chart on any one tab needs all of
 * them. They are cached for five minutes, which is how often the underlying
 * buckets change, so switching tabs costs nothing.
 */

const SELECTION_KEY = 'trend_series';
const MODE_KEY = 'trend_mode';

/**
 * Reads a remembered preference, tolerating a blocked or full localStorage.
 * @param {string} key - Storage key
 * @param {*} fallback - Value to use when nothing is stored
 * @returns {*} The stored value, or the fallback
 */
function remembered(key, fallback) {
    try {
        const stored = localStorage.getItem(key);
        return stored === null ? fallback : JSON.parse(stored);
    } catch (error) {
        return fallback;
    }
}

/**
 * Stores a preference, ignoring failures so a private-mode browser still works.
 * @param {string} key - Storage key
 * @param {*} value - Value to store
 * @returns {void}
 */
function remember(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        // A preference that cannot be saved is not worth interrupting the page for.
    }
}

export class Trends {
    constructor() {
        this.panels = new Map();
        this.days = new Map();
        this.pairs = [];
        this.selected = remembered(SELECTION_KEY, null);
        this.mode = remembered(MODE_KEY, 'split');
    }

    /**
     * The markup a station's panel is built into. The list of measurements is
     * deliberately left empty: which ones a station reports is only known once
     * its day has been read, and offering a measurement that draws nothing is
     * worse than waiting a moment for the real list.
     * @param {Object} station - A normalised station
     * @returns {string} HTML markup
     */
    render(station) {
        const menuId = `trend-menu-${station.key}`;

        return `
            <section class="trend" data-trend="${station.key}">
                <div class="trend-head">
                    <span class="label">
                        <span class="label-icon" aria-hidden="true">show_chart</span>Today so far
                    </span>

                    <div class="trend-controls">
                        <div class="trend-picker">
                            <button class="trend-picker-toggle" type="button"
                                    aria-expanded="false" aria-controls="${menuId}">
                                <span class="trend-picker-text">Measurements</span>
                                <span class="trend-count"></span>
                                <span class="trend-caret" aria-hidden="true">expand_more</span>
                            </button>

                            <div class="trend-menu" id="${menuId}" role="group"
                                 aria-label="Measurements" hidden></div>
                        </div>

                        <div class="trend-modes" role="group" aria-label="Chart layout">
                            <button class="trend-mode" type="button" data-mode="split"
                                    aria-pressed="${this.mode === 'split'}">Stacked</button>
                            <button class="trend-mode" type="button" data-mode="combined"
                                    aria-pressed="${this.mode === 'combined'}">Overlay</button>
                        </div>
                    </div>
                </div>

                <div class="chart-host"></div>
                <p class="trend-note">Reading today's log…</p>
            </section>`;
    }

    /**
     * Takes ownership of the panels just written to the page, then reads the
     * day behind them.
     *
     * Called after every refresh, because the page rebuilds its markup wholesale
     * and the old elements are gone. Days already read are kept, so a refresh
     * never blanks a chart the reader is looking at.
     *
     * @param {Object[]} entries - Station entries that have a panel on the page
     * @returns {void}
     */
    mount(entries) {
        this.panels.forEach(panel => {
            panel.chart.destroy();
            // These are on the document, not the panel, so they outlive the
            // markup they were bound for unless they are taken off by hand.
            document.removeEventListener('pointerdown', panel.dismiss);
            document.removeEventListener('keydown', panel.escape);
        });

        this.panels.clear();

        entries.forEach(entry => {
            const host = document.querySelector(`.trend[data-trend="${entry.station.key}"]`);
            if (!host) return;

            const panel = {
                station: entry.station,
                elevation: Number(entry.observation?.uk_hybrid?.elev),
                host,
                chart: new Chart(host.querySelector('.chart-host'))
            };

            this.panels.set(entry.station.key, panel);
            this.bind(panel);
        });

        // Deliberately not awaited: the readings are already on screen, and the
        // charts fill in underneath them.
        this.loadDays();
    }

    /**
     * Reads every station's day at once, then draws every panel.
     * @returns {Promise<void>}
     */
    async loadDays() {
        const panels = [...this.panels.values()];

        await Promise.all(panels.map(async panel => {
            try {
                const day = await history.load(panel.station.id);
                if (day) this.days.set(panel.station.key, day);
            } catch (error) {
                console.error(`Could not read the day for ${panel.station.id}:`, error);
            }
        }));

        this.pairs = lapsePairs(panels.map(panel => ({
            station: panel.station,
            elevation: panel.elevation,
            day: this.days.get(panel.station.key)
        })));

        this.panels.forEach(panel => this.apply(panel));
    }

    /**
     * Makes sure a panel that has just been shown is drawn at its real size.
     *
     * A chart drawn while its tab was hidden had no width to draw into, so the
     * first time a panel appears it needs one more pass.
     *
     * @param {string} key - The station key whose panel is now visible
     * @returns {void}
     */
    reveal(key) {
        this.panels.get(key)?.chart.scheduleDraw();
    }

    /**
     * Wires one panel's measurement list and layout buttons.
     * @param {Object} panel - A mounted panel
     * @returns {void}
     */
    bind(panel) {
        const toggle = panel.host.querySelector('.trend-picker-toggle');

        toggle.addEventListener('click', () => this.setMenu(panel, !this.isOpen(panel)));

        // Anywhere outside the list closes it, the way a select does, so it
        // never sits open over the chart it is meant to be changing.
        panel.dismiss = event => {
            if (!panel.host.querySelector('.trend-picker').contains(event.target)) {
                this.setMenu(panel, false);
            }
        };

        panel.escape = event => {
            if (event.key !== 'Escape' || !this.isOpen(panel)) return;
            this.setMenu(panel, false);
            toggle.focus();
        };

        document.addEventListener('pointerdown', panel.dismiss);
        document.addEventListener('keydown', panel.escape);

        panel.host.querySelector('.trend-menu').addEventListener('click', event => {
            const option = event.target.closest('.trend-option, .trend-bulk');
            if (!option) return;

            const bulk = event.target.closest('.trend-bulk');
            if (bulk) {
                this.selected = bulk.dataset.bulk === 'all'
                    ? this.catalogue().map(series => series.key)
                    : [];

                remember(SELECTION_KEY, this.selected);
                this.panels.forEach(other => this.apply(other));
                return;
            }

            const key = option.dataset.series;
            const showing = this.showing();

            this.selected = showing.includes(key)
                ? showing.filter(item => item !== key)
                : [...showing, key];

            remember(SELECTION_KEY, this.selected);
            this.panels.forEach(other => this.apply(other));
        });

        panel.host.querySelector('.trend-modes').addEventListener('click', event => {
            const button = event.target.closest('.trend-mode');
            if (!button) return;

            this.mode = button.dataset.mode;
            remember(MODE_KEY, this.mode);
            this.panels.forEach(other => this.apply(other));
        });
    }

    /**
     * @param {Object} panel - A mounted panel
     * @returns {boolean} Whether its measurement list is open
     */
    isOpen(panel) {
        return !panel.host.querySelector('.trend-menu').hidden;
    }

    /**
     * Opens or closes one panel's measurement list.
     * @param {Object} panel - A mounted panel
     * @param {boolean} open - Whether it should be open
     * @returns {void}
     */
    setMenu(panel, open) {
        panel.host.querySelector('.trend-menu').hidden = !open;
        panel.host.querySelector('.trend-picker-toggle')
            .setAttribute('aria-expanded', String(open));
    }

    /**
     * Every measurement on offer: the ones a station records, plus the lapse
     * rates worked out between stations.
     * @returns {Object[]} Series definitions
     */
    catalogue() {
        return [...SERIES, ...this.pairs];
    }

    /**
     * Which measurements are showing. Nothing stored yet means the ones marked
     * on by default, which is the set Weather Underground graphs plus the lapse
     * rates that it does not.
     * @returns {string[]} Series keys
     */
    showing() {
        return this.selected ?? this.catalogue().filter(series => series.on).map(series => series.key);
    }

    /**
     * A station's day with the lapse-rate lines folded in.
     *
     * They are computed against that station's own reading times, so they can
     * sit on the same crosshair as everything else on its chart.
     *
     * @param {Object} panel - A mounted panel
     * @returns {?Object} The day, or null when the station logged nothing
     */
    dayFor(panel) {
        const day = this.days.get(panel.station.key);
        if (!day) return null;

        const values = {...day.values};
        this.pairs.forEach(pair => {
            values[pair.key] = lapseColumn(pair, day.times);
        });

        return {...day, values};
    }

    /**
     * Redraws one panel's chips, chart and note from the current selection.
     * @param {Object} panel - A mounted panel
     * @returns {void}
     */
    apply(panel) {
        const day = this.dayFor(panel);
        const showing = this.showing();

        const available = this.catalogue().filter(series =>
            day?.values?.[series.key]?.some(value => value !== null));

        const menu = panel.host.querySelector('.trend-menu');
        const note = panel.host.querySelector('.trend-note');
        const chosen = available.filter(series => showing.includes(series.key));

        // Rebuilt in place, so the list stays open while measurements are
        // turned on and off and the chart changes underneath it.
        menu.innerHTML = `
            <div class="trend-menu-actions">
                <button class="trend-bulk" type="button" data-bulk="all">All</button>
                <button class="trend-bulk" type="button" data-bulk="none">Clear</button>
            </div>
            ${available.map(series => `
                <button class="trend-option" type="button" data-series="${series.key}"
                        aria-pressed="${showing.includes(series.key)}"
                        style="--series: ${series.colour}">
                    <span class="trend-swatch" aria-hidden="true"></span>
                    <span class="trend-option-label">${
                        series.group === 'lapse' ? `Lapse ${series.label}` : series.label
                    }</span>
                    <span class="trend-tick" aria-hidden="true">check</span>
                </button>`).join('')}`;

        panel.host.querySelector('.trend-count').textContent =
            available.length ? `${chosen.length} of ${available.length}` : '';

        // The buttons are written once with the markup, so the pressed one is
        // put back in step here whenever the choice changes.
        panel.host.querySelectorAll('.trend-mode').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode));
        });

        panel.chart.setCatalogue(this.catalogue());
        panel.chart.setDay(day);
        panel.chart.setView(showing, this.mode);

        note.textContent = this.note(panel, day, available);
    }

    /**
     * What the chart is doing, in a sentence.
     *
     * The one that matters is the relative case: three or more units cannot
     * share a scale, so the heights stop meaning anything and only the shapes
     * can be compared. Saying so beats letting someone read a false ratio off
     * two lines that happen to cross.
     *
     * @param {Object} panel - A mounted panel
     * @param {?Object} day - The day being charted
     * @param {Object[]} available - The measurements on offer
     * @returns {string} The note
     */
    note(panel, day, available) {
        if (!day) return 'No readings logged for today yet.';

        const showing = available.filter(series => this.showing().includes(series.key));

        if (!showing.length) return 'Pick a measurement to plot.';

        const reading = 'Hover or tap the chart to read every line at that moment.';

        if (this.mode === 'split') return `Each measurement on its own scale. ${reading}`;

        const units = new Set(showing.map(series => series.unit));

        if (units.size > 2) {
            return 'More than two units, so each line is drawn across its own range: '
                + 'compare the shapes, not the heights. Pick fewer to get real scales back.';
        }

        return units.size === 2
            ? `Left axis in ${[...units][0] || 'index'}, right in ${[...units][1] || 'index'}. ${reading}`
            : reading;
    }
}

const trends = new Trends();
export default trends;
