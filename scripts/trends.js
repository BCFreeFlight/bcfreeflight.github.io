import history from './history.js';
import air from './air.js';
import sounding from './sounding.js';
import {SERIES, AIR_SERIES, SKY_SERIES} from './config/series.js';
import {STORAGE_KEYS} from './config/defaults.js';
import {readJson, writeJson} from './lib/storage.js';
import {Chart} from './chart.js';
import {Windgram} from './windgram.js';
import {buildWindgram, sharedFrame, FEET} from './rasp.js';
import {buildForecastWindgram} from './rasp-model.js';
import {FORECAST_VIEW, DRAFT_CEILING} from './config/rasp.js';
import forecast from './forecast.js';
import {lapsePairs, lapseColumn} from './lapse-series.js';
import {airColumn} from './air-series.js';
import {sunTimes} from './lib/solar.js';
import {shadeColumn, cloudColumn} from './sky-series.js';

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

// One hour, for the daylight figure beside the sunrise and sunset.
const HOUR = 60 * 60 * 1000;

/**
 * Which day the windgram can be showing.
 *
 * The first is the drawing of what the stations actually recorded; the rest are
 * forecasts. Kept as one list because a stored choice has to be checked against
 * it: this pill has been renamed once already, and a reader who still has the
 * old name saved should get the default back rather than a set of buttons with
 * none of them lit.
 */
const WINDGRAM_DAYS = ['current', 'today', 'tomorrow'];
const FORECAST_DAYS = WINDGRAM_DAYS.slice(1);

export class Trends {
    constructor() {
        this.panels = new Map();
        this.days = new Map();
        this.airs = new Map();
        this.aloft = new Map();
        this.pairs = [];
        this.forecasts = null;
        this.forecast = null;
        // Whether the forecast is still in flight, as distinct from read and
        // empty. Only the second is worth telling a reader about.
        this.reading = true;
        this.selected = readJson(STORAGE_KEYS.trendSeries, null);
        this.mode = readJson(STORAGE_KEYS.trendMode, 'split');
        this.day = this.knownDay(readJson(STORAGE_KEYS.windgramDay, null));
    }

    /**
     * A stored day choice, or the default when it is one this version does not
     * recognise.
     * @param {?string} day - Whatever was saved
     * @returns {string} A day the drawing can actually show
     */
    knownDay(day) {
        return WINDGRAM_DAYS.includes(day) ? day : WINDGRAM_DAYS[0];
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
                        <span class="label-icon" aria-hidden="true">show_chart</span>Charts
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

                        <div class="trend-modes trend-layout" role="group" aria-label="Chart layout">
                            <button class="trend-mode" type="button" data-mode="split"
                                    aria-pressed="${this.mode === 'split'}">Stacked</button>
                            <button class="trend-mode" type="button" data-mode="combined"
                                    aria-pressed="${this.mode === 'combined'}">Overlay</button>
                            <button class="trend-mode" type="button" data-mode="windgram"
                                    aria-pressed="${this.mode === 'windgram'}">Windgrams</button>
                        </div>
                    </div>
                </div>

                <p class="trend-sun" hidden></p>
                ${station.isDefault ? this.renderDays() : ''}

                <div class="chart-host"></div>
                <div class="windgram-host" hidden></div>
                ${station.isDefault ? '<div class="forecast-host" hidden></div>' : ''}
                <p class="trend-note">Reading today's log…</p>
            </section>`;
    }

    /**
     * Which day the windgram is drawing.
     *
     * Sits under the sunrise line rather than up beside the layout buttons.
     * Those pick how the day is drawn and are always there; this picks *which*
     * day, only appears in windgram mode, and belongs next to the drawing it
     * changes rather than in a row that would reflow every time the mode did.
     *
     * Only on the launch's own panel. The forecast is read for one point and
     * every station on the hillside sits in the same square, so putting this on
     * all three would offer three copies of one drawing as though they were
     * three forecasts that happened to agree.
     *
     * @returns {string} HTML markup
     */
    renderDays() {
        const days = [
            {key: 'current', label: 'Current', title: 'Today so far, from the stations'},
            {key: 'today', label: 'Today', title: 'Forecast for today'},
            {key: 'tomorrow', label: 'Tomorrow', title: 'Forecast for tomorrow'}
        ];

        // Named twice on purpose: the buttons are written from this list and
        // read back against WINDGRAM_DAYS, so the two must agree.
        days.forEach(day => {
            if (!WINDGRAM_DAYS.includes(day.key)) throw new Error(`Unknown windgram day: ${day.key}`);
        });

        return `
            <div class="trend-days" role="group" aria-label="Windgram day" hidden>
                ${days.map(day => `
                    <button class="trend-day" type="button" data-day="${day.key}"
                            aria-label="${day.title}"
                            aria-pressed="${this.day === day.key}">${day.label}</button>`).join('')}
            </div>`;
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
            panel.windgram.destroy();
            panel.forecast?.destroy();
            // These are on the document, not the panel, so they outlive the
            // markup they were bound for unless they are taken off by hand.
            document.removeEventListener('pointerdown', panel.dismiss);
            document.removeEventListener('keydown', panel.escape);
        });

        this.panels.clear();

        entries.forEach(entry => {
            const host = document.querySelector(`.trend[data-trend="${entry.station.key}"]`);
            if (!host) return;

            const forecastHost = host.querySelector('.forecast-host');

            const panel = {
                station: entry.station,
                elevation: this.elevationFeet(entry),
                // Carried through for the windgram, which needs to know where
                // the sun is to tell sunlight from cloud, and which square of
                // model air to read. From the site's own configuration for the
                // same reason the elevation is: the position Weather
                // Underground holds is the one the station's owner typed in.
                ...this.where(entry),
                host,
                chart: new Chart(host.querySelector('.chart-host')),
                windgram: new Windgram(host.querySelector('.windgram-host')),
                // Only the launch has one, so only the launch offers the days.
                forecast: forecastHost ? new Windgram(forecastHost, FORECAST_VIEW) : null
            };

            this.panels.set(entry.station.key, panel);
            this.bind(panel);
        });

        // Deliberately not awaited: the readings are already on screen, and the
        // charts fill in underneath them.
        this.loadDays();
    }

    /**
     * Where a station stands.
     *
     * The site's own coordinates where it states them, and the ones Weather
     * Underground reports otherwise.
     *
     * @param {Object} entry - A station entry with its observation
     * @returns {Object} latitude and longitude
     */
    where(entry) {
        const named = entry.station.coordinates;

        return {
            latitude: named?.latitude ?? Number(entry.observation?.lat),
            longitude: named?.longitude ?? Number(entry.observation?.lon)
        };
    }

    /**
     * How high a station stands, in feet.
     *
     * From the site's own configuration where it is given. Weather Underground
     * also reports an elevation, but it is whatever the station's owner typed
     * in when they registered it, and the whole vertical geometry of the
     * windgram is built on these numbers — where the slabs sit, which station
     * the parcel is released from, how the model is anchored. That is not a
     * thing to take from a form field if the site can state it.
     *
     * Feet because every height in the drawing is, so that the two scales down
     * the sides of the panel stay exact rather than round-tripped.
     *
     * @param {Object} entry - A station entry with its observation
     * @returns {number} Feet above sea level, or NaN when nothing says
     */
    elevationFeet(entry) {
        const stated = entry.station.coordinates?.elevation;

        if (Number.isFinite(stated)) return stated / FEET;

        return Number(entry.observation?.uk_hybrid?.elev);
    }

    /**
     * Reads every station's day at once, then draws every panel.
     * @returns {Promise<void>}
     */
    async loadDays() {
        const panels = [...this.panels.values()];

        await Promise.all([
            ...panels.map(async panel => {
                try {
                    const day = await history.load(panel.station.id);
                    if (day) this.days.set(panel.station.key, day);
                } catch (error) {
                    console.error(`Could not read the day for ${panel.station.id}:`, error);
                }

                // Beside the day rather than inside it, because it is not the
                // station's reading: the panel already knows where it stands,
                // and panels in the same grid square share the one request.
                const overhead = await air.load(panel.latitude, panel.longitude);
                if (overhead) this.airs.set(panel.station.key, overhead);

                // The air above the top of the hill, which no station is
                // standing in. Only the windgram uses it, and only above the
                // last station.
                const modelled = await sounding.load(panel.latitude, panel.longitude);
                if (modelled) this.aloft.set(panel.station.key, modelled);
            }),
            // Read alongside the rest rather than after them. The three
            // drawings share one frame, and the frame is built from the highest
            // thermal any of them has — so the forecast has to be in hand
            // before the first of them can be drawn, or the measured chart
            // would be drawn once and then jump to a new axis a moment later.
            this.loadForecast(panels)
        ]);

        this.pairs = lapsePairs(panels.map(panel => ({
            station: panel.station,
            elevation: panel.elevation,
            day: this.days.get(panel.station.key)
        })));

        // Built once from every station, because a windgram is a slice through
        // the whole hillside rather than a property of any one tab. Every
        // panel is then handed the same drawing.
        // The profile aloft is a property of the hillside rather than of any
        // one station, so the launch station's square is the one asked about —
        // the same square the drawing releases its thermals in.
        const launch = panels.find(panel => panel.station.isDefault) ?? panels[0];

        this.charted = panels.map(panel => ({
            station: panel.station,
            elevationFeet: panel.elevation,
            latitude: panel.latitude,
            longitude: panel.longitude,
            day: this.days.get(panel.station.key)
        }));

        this.aloftAtLaunch = launch ? this.aloft.get(launch.station.key) ?? null : null;

        this.rebuild();
        this.panels.forEach(panel => this.apply(panel));
    }

    /**
     * Draws every windgram once to find out how high the day goes, then draws
     * them all again in the frame that answer implies.
     *
     * Two passes rather than one, because the frame cannot be known before the
     * drawings and the drawings cannot be made without a frame. The first pass
     * is thrown away: it exists only to report the thermal tops, and it is drawn
     * to a ceiling nothing reaches so that none of them come back clipped.
     *
     * Both passes are arithmetic over sixty columns and neither asks anything of
     * the network — every reading and both halves of the forecast are already in
     * hand by the time this runs.
     *
     * @returns {void}
     */
    rebuild() {
        if (!this.charted?.length) return;

        const lowest = Math.min(...this.charted
            .filter(entry => Number.isFinite(entry.elevationFeet))
            .map(entry => entry.elevationFeet * FEET));

        const draft = this.build({floor: lowest, ceiling: DRAFT_CEILING});

        Object.assign(this, this.build(sharedFrame(this.drawings(draft), lowest)));
    }

    /**
     * The three drawings of one build, as a list.
     * @param {Object} built - windgram and forecasts
     * @returns {Array<?Object>} The models, in the order the pills offer them
     */
    drawings({windgram, forecasts}) {
        return [windgram, forecasts?.today, forecasts?.tomorrow];
    }

    /**
     * Every windgram on the panel, drawn in one frame.
     * @param {Object} frame - The floor and ceiling they share
     * @returns {Object} windgram and forecasts
     */
    build(frame) {
        const windgram = buildWindgram(this.charted, this.aloftAtLaunch, frame);

        const forecasts = this.forecast
            ? {
                today: buildForecastWindgram(this.forecast, {...this.launchAt, day: 0, frame}),
                tomorrow: buildForecastWindgram(this.forecast, {...this.launchAt, day: 1, frame})
            }
            : null;

        return {windgram, forecasts};
    }

    /**
     * Reads the forecast for the launch and builds both of its days.
     *
     * Asked about the launch's own coordinates from the site's configuration
     * rather than the ones Weather Underground holds for the sensor: the
     * response carries the terrain height of the point it was asked about, and
     * that height is the ground the whole forecast drawing sits on.
     *
     * @returns {Promise<void>}
     */
    async loadForecast(panels) {
        const panel = panels.find(entry => entry.forecast);

        if (!panel) {
            this.reading = false;
            return;
        }

        // The panel already carries the launch's own coordinates.
        this.launchAt = {latitude: panel.latitude, longitude: panel.longitude};

        try {
            this.forecast = await forecast.load(this.launchAt.latitude, this.launchAt.longitude);
        } finally {
            this.reading = false;
        }
    }

    /**
     * Takes the newest readings without disturbing anything on screen.
     *
     * Called when the page refreshes in place. `mount` would tear every chart
     * down and build it again, which closes an open measurement list and blinks
     * the charts; this keeps the panels exactly as they are and only re-reads.
     * The day is cached, so most refreshes cost nothing at all.
     *
     * @returns {Promise<void>}
     */
    refresh() {
        return this.loadDays();
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
        const panel = this.panels.get(key);
        panel?.chart.scheduleDraw();
        panel?.windgram.scheduleDraw();
        panel?.forecast?.scheduleDraw();
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

                writeJson(STORAGE_KEYS.trendSeries, this.selected);
                this.panels.forEach(other => this.apply(other));
                return;
            }

            const key = option.dataset.series;
            const showing = this.showing();

            this.selected = showing.includes(key)
                ? showing.filter(item => item !== key)
                : [...showing, key];

            writeJson(STORAGE_KEYS.trendSeries, this.selected);
            this.panels.forEach(other => this.apply(other));
        });

        panel.host.querySelector('.trend-layout').addEventListener('click', event => {
            const button = event.target.closest('.trend-mode');
            if (!button) return;

            this.mode = button.dataset.mode;
            writeJson(STORAGE_KEYS.trendMode, this.mode);
            this.panels.forEach(other => this.apply(other));
        });

        panel.host.querySelector('.trend-days')?.addEventListener('click', event => {
            const button = event.target.closest('.trend-day');
            if (!button) return;

            this.day = button.dataset.day;
            writeJson(STORAGE_KEYS.windgramDay, this.day);
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
        return [...SERIES, ...this.pairs, AIR_SERIES, ...SKY_SERIES];
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
     * A station's day with everything that is not its own reading folded in:
     * the lapse rates between it and its neighbours, and the air over it.
     *
     * All of it is computed against that station's own reading times, so every
     * line sits on the same crosshair as the measurements it was logged beside.
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

        const overhead = airColumn(this.airs.get(panel.station.key), day.times);
        if (overhead) values[AIR_SERIES.key] = overhead;

        // What was between this station and the sun. Shade comes from its own
        // pyranometer and needs to know where it was standing; cloud comes from
        // the model over the same square.
        const shade = shadeColumn(day, panel.latitude, panel.longitude);
        if (shade) values.shade = shade;

        const cloud = cloudColumn(this.aloft.get(panel.station.key), day.times);
        if (cloud) values.cloud = cloud;

        return {...day, values};
    }

    /**
     * When the sun came up and when it goes down, over the chart it bounds.
     *
     * Worth stating outright rather than leaving to be read off the solar
     * radiation line, because it is the one thing on this panel that is about
     * the rest of the day rather than the part already logged: everything else
     * here stops at the last reading.
     *
     * Both come from the station's own coordinates and the date, which is all
     * the sun needs — no service is asked, and the answer does not change if one
     * is unreachable.
     *
     * @param {Object} panel - A mounted panel
     * @param {?Object} day - The day being charted, for the date it falls on
     * @returns {void}
     */
    renderSun(panel, {sunrise, sunset, up}) {
        const host = panel.host.querySelector('.trend-sun');
        if (!host) return;

        if (sunrise === null || sunset === null) {
            // Only reachable inside the arctic circle, where there is no
            // sunrise to name. Better to say which kind of day it is than to
            // leave the reader looking for a time that does not exist.
            host.hidden = up === null;
            host.textContent = up === true ? 'The sun does not set today.'
                : up === false ? 'The sun does not rise today.' : '';
            return;
        }

        const clock = at => new Date(at).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
        const daylight = sunset - sunrise;

        host.hidden = false;
        host.innerHTML = `
            <span class="trend-sun-item">
                <span class="trend-sun-icon material-symbols-outlined" aria-hidden="true">wb_twilight</span>
                Sunrise <strong>${clock(sunrise)}</strong>
            </span>
            <span class="trend-sun-item">
                <span class="trend-sun-icon material-symbols-outlined" aria-hidden="true">bedtime</span>
                Sunset <strong>${clock(sunset)}</strong>
            </span>
            <span class="trend-sun-length">${Math.floor(daylight / HOUR)}h ${
                Math.round((daylight % HOUR) / 60000)}m of daylight</span>`;
    }

    /**
     * Redraws one panel's chips, chart and note from the current selection.
     * @param {Object} panel - A mounted panel
     * @returns {void}
     */
    apply(panel) {
        const day = this.dayFor(panel);
        const showing = this.showing();

        // Noon rather than midnight, so the day being asked about is the same
        // one whichever side of UTC the station sits.
        const sun = sunTimes((day?.dayStart ?? Date.now()) + 12 * HOUR,
            panel.latitude, panel.longitude);

        this.renderSun(panel, sun);

        // The windgram is not a selection of measurements, so its mode hides
        // the picker rather than leaving a control that changes nothing.
        const profile = this.mode === 'windgram';

        // A panel with no forecast of its own only ever draws what was
        // measured, whichever day is chosen on the launch's panel.
        //
        // Tested against the days there are rather than against the one there
        // is not, so a stored choice this version does not recognise — the
        // pill was called something else once — falls back to the measured
        // drawing rather than to an empty forecast.
        const drawing = panel.forecast ? this.day : 'current';
        const ahead = profile && FORECAST_DAYS.includes(drawing);

        panel.host.querySelector('.chart-host').hidden = profile;
        panel.host.querySelector('.windgram-host').hidden = !profile || ahead;
        panel.host.querySelector('.trend-picker').hidden = profile;

        const days = panel.host.querySelector('.trend-days');
        if (days) days.hidden = !profile;

        const forecastHost = panel.host.querySelector('.forecast-host');
        if (forecastHost) forecastHost.hidden = !ahead;

        if (profile) {
            this.setMenu(panel, false);

            if (ahead) panel.forecast.setModel(this.forecasts?.[drawing] ?? null);
            else panel.windgram.setModel(this.windgram);
        }

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
        panel.host.querySelectorAll('.trend-layout .trend-mode').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.mode === this.mode));
        });

        panel.host.querySelectorAll('.trend-day').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.day === this.day));
        });

        panel.chart.setCatalogue(this.catalogue());
        panel.chart.setSun(sun);
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

        if (this.mode === 'windgram') {
            if (panel.forecast && FORECAST_DAYS.includes(this.day)) {
                if (this.reading) return 'Reading the forecast…';

                // Read and came back with nothing — the service was unreachable
                // or is rate-limiting us. Saying so beats "Reading…" forever.
                if (!this.forecast) return 'The forecast service could not be reached. It will be tried again shortly.';

                if (!this.forecasts?.[this.day]) return 'No forecast for this day yet.';

                return 'The same column of air, forecast rather than measured, from the HRDPS '
                    + 'model the Canadian RASP is built on. Colour is stability, barbs are the '
                    + 'wind aloft, and the glider marks how high a thermal would get.';
            }

            if (!this.windgram) return 'Not enough logged today to draw the profile yet.';

            return this.windgram.stations.length < 2
                ? 'Only one station is reporting, so there is no profile to draw between them. '
                    + 'The barbs and the strips are still today\'s readings.'
                : 'The hillside as a column of air, in the shape RASP draws it. Colour is stability '
                    + 'between the stations, barbs are the wind at each one, and the glider marks '
                    + 'how high a thermal would get. Hover to read a moment.';
        }

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
