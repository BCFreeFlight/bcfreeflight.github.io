import time from './time.js';
import weather from './weather.js';
import air from './air.js';
import sites from './sites.js';
import youtube from './youtube.js';
import trends from './trends.js';
import * as readings from './readings.js';
import {READOUTS} from './config/readouts.js';
import {CAMERA_CHECK_MS, RETRY_MS} from './config/defaults.js';
import {Loop} from './lib/loop.js';

const NO_READING = readings.NO_READING;

/**
 * Class for handling index page functionality
 */
export class Index {
    constructor() {
        this.refresh = new Loop(() => this.processWeather());
    }

    /**
     * An arrow, pointing the way the wind is going.
     *
     * The same glyph the live page uses, at the same rotation: the reading
     * names the direction the wind blows *from*, so the arrow points 180
     * degrees away from it. A windsock read well to anyone who has stood under
     * one and not at all to anyone who has not — an arrow needs no explaining,
     * and the direction is written out beneath it either way.
     *
     * @param {Object} wind - A shared wind reading: cardinal, rotation, words
     * @returns {string} HTML markup
     */
    renderWindArrow(wind) {
        return `<span class="wind-arrow" role="img"
                      aria-label="Wind from the ${wind.cardinalWords ?? 'unknown direction'}"
                      style="transform: rotate(${wind.rotation}deg);">navigation</span>`;
    }

    /**
     * The lapse-rate tag that rides on the tab bar. Lapse rate is measured
     * between the two stations, so it sits alongside the tabs rather than
     * inside one, and it reads the same whichever station is selected.
     *
     * The stability band shows as one colour rather than a marker on the full
     * spectrum: at a glance the answer is the colour, and the legend it used to
     * carry was more chart than a person needs to read in passing.
     *
     * @param {Object[]} loaded - Station entries from Weather.loadStations
     * @returns {string} HTML markup
     */
    renderLapseTag(loaded) {
        const segments = readings.lapseSegments(loaded);

        if (!segments.length) {
            const offline = loaded.filter(entry => !entry.online).map(entry => entry.station.name);

            return `
                <div class="lapse-tag">
                    <span class="label">Lapse rate <span class="label-unit">(ºC/1000 ft)</span></span>
                    <p class="lapse-sub">${
                        offline.length ? `${offline.join(' and ')} offline` : 'Needs two stations reporting'
                    }</p>
                </div>`;
        }

        return `
            <div class="lapse-tag">
                <span class="label">Lapse rate <span class="label-unit">(ºC/1000 ft)</span></span>
                <div class="lapse-segments">
                    ${segments.map(segment => `
                        <div class="lapse-segment" title="${segment.name}: ${segment.description}">
                            <span class="lapse-swatch" style="background: ${segment.colour};" aria-hidden="true"></span>
                            <span class="lapse-figure">${segment.rate.toFixed(2)}</span>
                            <span class="lapse-span">${segment.span}</span>
                            <span class="lapse-gap">${segment.elevDiff.toLocaleString()} ft</span>
                        </div>`).join('')}
                </div>
            </div>`;
    }

    /**
     * The secondary readings for one station, in reading order.
     *
     * Which tiles there are, and where each one's value comes from, is in the
     * readouts configuration. This only knows how to draw one.
     *
     * @param {Object} observation - A station observation
     * @param {Object} metrics - Interpreted metrics for that same observation
     * @param {?Object} airQuality - The air over the station, when it is known
     * @returns {string} HTML markup
     */
    renderReadouts(observation, metrics, airQuality) {
        const readoutList = READOUTS.map(readout => ({
            label: readout.label,
            icon: readout.icon,
            value: readout.read(observation, metrics, airQuality) ?? NO_READING,
            unit: typeof readout.unit === 'function'
                ? readout.unit(observation, metrics, airQuality)
                : readout.unit,
            note: readout.note?.(observation, metrics, airQuality)
        }));

        return `
            <section class="readouts">
                ${readoutList.map((item, i) => `
                    <div class="readout" style="--i: ${i}">
                        <span class="label"><span class="label-icon" aria-hidden="true">${item.icon}</span>${item.label}</span>
                        <p class="readout-value${item.value === NO_READING ? ' is-empty' : ''}">${item.value}${item.unit ? `<span class="unit">${item.unit}</span>` : ''}</p>
                        ${item.note ? `<p class="readout-note">${item.note}</p>` : ''}
                    </div>`).join('')}
            </section>`;
    }

    /**
     * A full readings panel for one station.
     * @param {Object} entry - A station entry: station, observation, metrics
     * @returns {string} HTML markup
     */
    /**
     * The two wind tiles: which way it is blowing, and how hard.
     *
     * Kept apart from the panel around it because a refresh rewrites these two
     * tiles on their own, leaving everything else — including the chart — where
     * it stands.
     *
     * @param {Object} wind - A shared wind reading
     * @returns {string} HTML markup
     */
    renderWindRow(wind) {
        return `
                <div class="wind-row">
                    <section class="wind-card wind-card--direction">
                        <span class="label"><span class="label-icon" aria-hidden="true">explore</span>Wind direction</span>

                        ${this.renderWindArrow(wind)}

                        <p class="wind-cardinal">${wind.cardinal}</p>
                    </section>

                    <section class="wind-card wind-card--speed">
                        <span class="label"><span class="label-icon" aria-hidden="true">air</span>Wind</span>

                        <p class="wind-speed">${wind.speed}<span class="unit">km/h</span></p>

                        ${wind.gusting
                            ? `<p class="wind-gust">Gusting to <strong>${wind.gust} km/h</strong></p>`
                            : ''}
                    </section>
                </div>`;
    }

    renderStationView(entry) {
        const key = entry.station.key;

        return `
            <div class="view" id="panel-${key}" role="tabpanel" tabindex="0"
                 aria-labelledby="tab-${key}" data-view="${key}" hidden>
                ${this.renderWindRow(readings.wind(entry.observation))}
                ${this.renderReadouts(entry.observation, entry.metrics, entry.air)}
                ${trends.render(entry.station)}
            </div>`;
    }

    /**
     * Rebuilds part of the page without moving the reader.
     *
     * Replacing markup empties the document for an instant, and a document with
     * no height cannot hold a scroll position — the browser clamps it to the top
     * and the reader loses their place. Putting it back afterwards is not quite
     * enough on its own either, because the charts size themselves a frame
     * later and the page grows again underneath; hence the second pass.
     *
     * @param {function(): void} rebuild - The work that replaces markup
     * @returns {void}
     */
    keepingPlace(rebuild) {
        const top = window.scrollY;

        rebuild();

        // Nothing to restore if the reader had not scrolled at all.
        if (!top) return;

        window.scrollTo({top, behavior: 'instant'});
        requestAnimationFrame(() => window.scrollTo({top, behavior: 'instant'}));
    }

    /**
     * What the page is built out of, as a string.
     *
     * Everything that decides the *shape* of the page goes in here: which
     * stations there are, what order they are in, and which of them are
     * reporting. Readings deliberately do not — they change every minute, and
     * changing a reading should never cost the reader their place on the page.
     *
     * @param {Object[]} loaded - Station entries from Weather.loadStations
     * @returns {string} A signature to compare against what is on screen
     */
    signature(loaded) {
        return loaded
            .map(entry => `${entry.station.key}:${entry.online ? 'on' : 'off'}`)
            .join('|');
    }

    /**
     * Writes new readings into the page that is already there.
     *
     * The page used to be rebuilt from scratch on every refresh, which threw
     * away the reader's scroll position — the document collapsed to nothing for
     * an instant and the browser pinned the scroll back to the top. It also
     * tore down every chart, along with any measurement list left open.
     *
     * So when the shape has not changed, only the values are replaced: the
     * panels, the tabs and the charts are the same elements they were a minute
     * ago, and nothing moves under the reader.
     *
     * @param {Object[]} loaded - Station entries, online or not
     * @returns {void}
     */
    updateInPlace(loaded) {
        const lapse = document.querySelector('.lapse-tag');
        if (lapse) lapse.outerHTML = this.renderLapseTag(loaded);

        loaded.forEach(entry => {
            const key = entry.station.key;

            const meta = document.querySelector(`.tab[data-view="${key}"] .tab-meta`);
            if (meta) {
                meta.textContent = entry.online
                    ? `${Number(entry.observation.uk_hybrid.elev).toLocaleString()} ft ASL`
                    : 'offline';
            }

            const view = document.querySelector(`.view[data-view="${key}"]`);
            if (!view || !entry.online) return;

            const wind = view.querySelector('.wind-row');
            if (wind) wind.outerHTML = this.renderWindRow(readings.wind(entry.observation));

            const readouts = view.querySelector('.readouts');
            if (readouts) readouts.outerHTML = this.renderReadouts(entry.observation, entry.metrics, entry.air);
        });

        // The charts read their own day on their own cadence; this asks them to
        // take the newest one without unmounting anything.
        trends.refresh();
    }

    /**
     * The station switcher. Offline stations stay listed but disabled, so the
     * page says which station is missing rather than hiding it.
     * @param {Object[]} loaded - Station entries in tab order, online or not
     * @returns {string} HTML markup
     */
    renderTabs(loaded) {
        return `
            <div class="tab-row">
                <div class="tabs" role="tablist" aria-label="Weather station">
                    ${loaded.map(entry => `
                        <button class="tab" type="button" role="tab" id="tab-${entry.station.key}"
                                aria-controls="panel-${entry.station.key}" aria-selected="false"
                                data-view="${entry.station.key}" tabindex="-1"
                                ${entry.online ? '' : 'disabled'}>
                            <span class="tab-name">${entry.station.name}</span>
                            <span class="tab-meta">${
                                entry.online
                                    ? `${Number(entry.observation.uk_hybrid.elev).toLocaleString()} ft ASL`
                                    : 'offline'
                            }</span>
                        </button>`).join('')}
                </div>

                ${this.renderLapseTag(loaded)}
            </div>`;
    }

    /**
     * Shows one station's panel. The masthead is deliberately left alone: it
     * describes the site, not whichever tab happens to be open.
     * @param {string} key - The view key to activate
     * @param {Object} lookup - View key to its station entry
     * @returns {void}
     */
    activateView(key, lookup) {
        document.querySelectorAll('.tab').forEach(tab => {
            const selected = tab.dataset.view === key;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
        });

        document.querySelectorAll('.view').forEach(panel => {
            panel.hidden = panel.dataset.view !== key;
        });

        // A chart cannot size itself inside a hidden panel, so it is told the
        // moment its panel is on screen.
        trends.reveal(key);
    }

    /**
     * Writes the site's own coordinates and observation time into the masthead.
     *
     * These come from the station marked default in the configuration and stay
     * put while tabs are switched, so the heading keeps describing the site
     * rather than following the reader around. If that station is dark, the
     * first one still reporting stands in rather than leaving a blank heading.
     *
     * @param {Object[]} loaded - Station entries from Weather.loadStations
     * @returns {void}
     */
    renderMasthead(loaded) {
        const lastUpdatedElement = document.getElementById('last-updated');
        const locationElement = document.getElementById('location');

        const source = loaded.find(entry => entry.station.isDefault && entry.online)
            ?? loaded.find(entry => entry.online);

        if (!source) {
            lastUpdatedElement.textContent = 'no signal';
            locationElement.textContent = '';
            return;
        }

        const uk = source.observation.uk_hybrid ?? {};
        lastUpdatedElement.textContent = time.format(new Date(source.observation.obsTimeUtc));
        locationElement.innerHTML =
            `${source.observation.lat.toFixed(3)}, ${source.observation.lon.toFixed(3)}` +
            `<span class="sep">@</span>${Number(uk.elev).toLocaleString()} ft ASL`;
    }

    /**
     * Wires clicks and left/right arrow keys on the station switcher.
     * @param {Object[]} enabled - The views that have data
     * @param {Object} lookup - View key to its observation and station id
     * @returns {void}
     */
    bindTabs(enabled, lookup, preferredKey = null) {
        const tabs = [...document.querySelectorAll('.tab:not([disabled])')];

        tabs.forEach(tab => {
            tab.addEventListener('click', () => this.activateView(tab.dataset.view, lookup));
            tab.addEventListener('keydown', event => {
                const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
                this.activateView(next.dataset.view, lookup);
                next.focus();
            });
        });

        // Keep the reader where they were, unless that station has since gone dark.
        const restored = preferredKey && lookup[preferredKey] ? preferredKey : enabled[0].station.key;
        this.activateView(restored, lookup);
    }

    /**
     * Names the page after the site it is showing. The heading, the tab title
     * and the description all come from sites.json, so a site is spelled out in
     * one place rather than in each page's markup.
     * @param {Object} site - The resolved site
     * @returns {void}
     */
    renderSiteIdentity(site) {
        document.title = site.name;

        const heading = document.getElementById('site-name');
        if (heading) heading.textContent = site.name;

        const description = document.querySelector('meta[name="description"]');
        if (description) {
            description.setAttribute('content',
                `Live wind, thermal, and weather conditions at ${site.name}.`);
        }
    }

    /**
     * Points the camera link at the live page while the stream is up, and turns
     * it into a plain "Offline" marker when it is not.
     *
     * The check runs after the weather has rendered, so a slow or unreachable
     * YouTube never holds up the readings.
     *
     * @param {Object} site - The resolved site
     * @returns {Promise<void>}
     */
    async updateCameraLink(site) {
        const link = document.getElementById('live-link');
        if (!link) return;

        const camera = sites.withCamera(site.stations);

        if (!camera) {
            link.hidden = true;
            return;
        }

        // Each check starts a hidden player, so it runs far less often than the
        // readings refresh.
        const now = Date.now();
        if (this.lastCameraCheck && now - this.lastCameraCheck < CAMERA_CHECK_MS) return;
        this.lastCameraCheck = now;

        let live;
        try {
            live = await youtube.isLive(camera.youtube);
        } catch (error) {
            // Leave the link as it is: an unreachable API is not proof of an
            // off-air camera, and a working link beats a wrong "Offline".
            console.error('Could not determine live status:', error);
            return;
        }

        this.setCameraState(link, live);
    }

    /**
     * Puts the camera link into its live or off-air state. Both directions are
     * handled, so a camera that comes back mid-session gets its link back.
     * @param {HTMLElement} link - The camera link
     * @param {boolean} live - Whether the camera is broadcasting
     * @returns {void}
     */
    setCameraState(link, live) {
        if (live) {
            link.classList.remove('is-offline');
            link.setAttribute('href', 'live');
            link.removeAttribute('aria-disabled');
            link.removeAttribute('title');
            link.innerHTML = '<span class="live-dot" aria-hidden="true"></span>Live camera';
            return;
        }

        link.classList.add('is-offline');
        link.removeAttribute('href');
        link.setAttribute('aria-disabled', 'true');
        link.textContent = 'Camera offline';
        link.title = 'The camera is not broadcasting right now';
    }

    /**
     * Hangs the air over each station onto its entry.
     *
     * The coordinates come from the observations themselves, so this can only
     * run once the stations have answered. Stations near each other resolve to
     * the same grid square and share a single request, and a station that is
     * dark simply gets nothing — there is nowhere to ask about.
     *
     * A failure here is left as a missing tile rather than raised: the readings
     * are the page, and air quality is one line beside them.
     *
     * @param {Object[]} loaded - Station entries from Weather.loadStations
     * @returns {Promise<void>}
     */
    async loadAir(loaded) {
        await Promise.all(loaded.map(async entry => {
            if (!entry.online) return;

            try {
                entry.air = await air.load(entry.observation.lat, entry.observation.lon);
            } catch (error) {
                console.error('Could not read the air quality:', error);
            }
        }));
    }

    /**
     * Queues the next read at the site's own cadence.
     *
     * The interval is the shortest cache timeout in the configuration, so each
     * station comes back exactly as often as its own setting allows: the
     * frequent one refetches, the slower ones are served from cache until their
     * timeout lapses. No station is polled harder than it asked for.
     *
     * @param {Object} site - The resolved site
     * @returns {void}
     */
    scheduleRefresh(site) {
        this.refresh.in(sites.refreshMs(site.stations));
    }

    /**
     * Process and display weather data
     * @returns {Promise<void>}
     */
    async processWeather() {
        const weatherDataContainer = document.getElementById('weather-data');
        const lastUpdatedElement = document.getElementById('last-updated');

        try {
            const site = await sites.site(sites.slugFromPage());

            // Name the page before fetching anything, so a station that fails
            // still leaves the site identified rather than blank.
            this.renderSiteIdentity(site);

            const loaded = await weather.loadStations(sites.inTabOrder(site.stations));

            // Needs the stations first: the coordinates to ask about are in
            // their observations. Held for half an hour, so most refreshes come
            // straight back from cache.
            await this.loadAir(loaded);

            // Whichever stations answered. One being dark never hides the others.
            const enabled = loaded.filter(entry => entry.online);

            if (!enabled.length) {
                lastUpdatedElement.textContent = 'no signal';
                weatherDataContainer.innerHTML = `
                    <div class="state">
                        <p class="state-title">Every station is dark</p>
                        <p>None of ${loaded.map(entry => entry.station.id).join(', ')} is reporting. Try
                           <a href="https://wunderground.com/dashboard/pws/${loaded[0].station.id}" target="_blank" rel="noopener">${loaded[0].station.name} on Weather Underground</a>.</p>
                    </div>`;

                // Nothing is on the page to update any more.
                this.rendered = null;
                this.scheduleRefresh(site);
                return;
            }

            const offline = loaded.filter(entry => !entry.online).map(entry => entry.station.name);
            const notice = offline.length
                ? `<p class="notice">${offline.join(' and ')} ${offline.length > 1 ? 'are' : 'is'} offline. Showing the ${
                    enabled.length > 1 ? 'remaining stations' : 'one station still reporting'
                }.</p>`
                : '';

            const signature = this.signature(loaded);

            if (signature === this.rendered) {
                // Same stations, same shape: only the numbers moved. Write them
                // into the page that is already there, so the reader keeps their
                // scroll position, their open measurement list and their charts.
                this.updateInPlace(loaded);
                this.renderMasthead(loaded);
            } else {
                // Which tab the reader was on, so a refresh does not send them
                // back to the first station mid-read.
                const selected = document.querySelector('.tab[aria-selected="true"]')?.dataset.view;
                const hadFocus = document.activeElement?.classList.contains('tab');

                this.keepingPlace(() => {
                    weatherDataContainer.innerHTML =
                        notice +
                        this.renderTabs(loaded) +
                        enabled.map(entry => this.renderStationView(entry)).join('');

                    this.renderMasthead(loaded);

                    // Before the tabs, so the panel revealed by activateView
                    // already has a chart to size.
                    trends.mount(enabled);

                    const lookup = Object.fromEntries(enabled.map(entry => [entry.station.key, entry]));
                    this.bindTabs(enabled, lookup, selected);
                });

                if (hadFocus) {
                    document.querySelector('.tab[aria-selected="true"]')?.focus();
                }

                this.rendered = signature;
            }

            // Deliberately not awaited: the readings are already on screen.
            this.updateCameraLink(site);
            this.scheduleRefresh(site);

        } catch (error) {
            console.error("Error in weather app:", error);
            weatherDataContainer.innerHTML = `
                <div class="state">
                    <p class="state-title">Couldn't reach the stations</p>
                    <p>The weather service didn't answer. Trying again shortly.</p>
                </div>`;

            // The page is now a message rather than a set of panels, so the
            // next good read has to build them again.
            this.rendered = null;

            // Keep trying: a failed load must not end the refresh loop.
            this.refresh.in(RETRY_MS);
        }
    }
}

// Export a default instance of the Index class
const index = new Index();
export default index;
