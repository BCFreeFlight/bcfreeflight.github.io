import time from './time.js';
import weather from './weather.js';
import sites from './sites.js';
import youtube from './youtube.js';
import trends from './trends.js';
import * as readings from './readings.js';

// Speed at which the windsock reads fully extended, in km/h.
const WINDSOCK_FULL = 20;

// Camera status costs a hidden player to check, so it lags the readings.
const CAMERA_CHECK_MS = 5 * 60 * 1000;

// How long to wait before trying again when the whole load fails.
const RETRY_MS = 60 * 1000;

const NO_READING = readings.NO_READING;

/**
 * Class for handling index page functionality
 */
export class Index {
    /**
     * A windsock, pointing the way the wind is going.
     *
     * It stands on its own rather than on a compass dial: the direction is
     * written out in words beside it, so the picture only has to show which way
     * the wind blows, not let anyone measure a bearing off it. The sock fills
     * out with speed too, limp when calm and streaming by WINDSOCK_FULL.
     *
     * @param {Object} wind - A shared wind reading: cardinal, rotation, words
     * @param {?number} windSpeed - Wind speed in km/h
     * @returns {string} SVG markup
     */
    renderWindsock(wind, windSpeed) {
        const cx = 120, cy = 120;
        const rotation = wind.rotation;
        const fullLength = 150;

        // Fraction of full extension, so a calm sock reads as a stubby cone.
        const extension = 0.42 + 0.58 * Math.min((windSpeed ?? 0) / WINDSOCK_FULL, 1);
        const length = fullLength * extension;

        // Straddle the hub, so a short sock stays centred instead of drifting upwind.
        const mouthY = cy + length / 2;

        const mouthHalf = 26;
        const tailHalf = 10;
        const bandCount = 5;

        const at = step => {
            const t = step / bandCount;
            return {
                y: mouthY - length * t,
                half: mouthHalf + (tailHalf - mouthHalf) * t
            };
        };

        let bands = '';
        for (let i = 0; i < bandCount; i++) {
            const from = at(i);
            const to = at(i + 1);
            bands += `<path d="M${cx - from.half} ${from.y} L${cx + from.half} ${from.y}
                               L${cx + to.half} ${to.y} L${cx - to.half} ${to.y} Z"
                            fill="${i % 2 === 0 ? '#ee6a10' : '#ffffff'}"
                            stroke="#16202b" stroke-opacity=".35" stroke-width="1"
                            stroke-linejoin="round"/>`;
        }

        return `
            <svg class="windsock" viewBox="0 0 240 240" role="img"
                 aria-label="Wind from the ${wind.cardinalWords ?? 'unknown direction'}">
                <g style="transform: rotate(${rotation}deg); transform-origin: ${cx}px ${cy}px;">
                    ${bands}
                    <ellipse cx="${cx}" cy="${mouthY}" rx="${mouthHalf}" ry="6"
                             fill="#ee6a10" stroke="#16202b" stroke-opacity=".35" stroke-width="1"/>
                </g>
            </svg>`;
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
     * @param {Object} observation - A station observation
     * @param {Object} metrics - Interpreted metrics for that same observation
     * @returns {string} HTML markup
     */
    renderReadouts(observation, metrics) {
        const readoutList = [
            {
                label: 'Temperature',
                icon: 'device_thermostat',
                value: readings.temperature(observation).celsius,
                unit: 'ºC'
            },
            {
                label: 'Dew Point',
                icon: 'opacity',
                value: metrics.dewPoint?.celsius ?? NO_READING,
                unit: 'ºC',
                note: metrics.dewPoint?.description
            },
            {
                label: 'Humidity',
                icon: 'humidity_percentage',
                value: metrics.humidity?.percent ?? NO_READING,
                unit: '%',
                note: metrics.humidity?.description
            },
            {
                label: 'Heat Index',
                icon: 'wb_sunny',
                value: metrics.heatIndex?.celsius ?? NO_READING,
                unit: 'ºC',
                note: metrics.heatIndex?.description
            },
            {
                label: 'Wind Chill',
                icon: 'ac_unit',
                value: metrics.windChill?.celsius ?? NO_READING,
                unit: 'ºC',
                note: metrics.windChill?.description
            },
            {
                label: 'Barometric Pressure',
                icon: 'speed',
                value: metrics.barometricPressure?.kPa ?? NO_READING,
                unit: metrics.barometricPressure ? 'kPa' : '',
                note: metrics.barometricPressure?.description ?? 'This station does not report pressure.'
            },
            {
                label: 'UV Index',
                icon: 'light_mode',
                value: observation.uv ?? NO_READING,
                note: metrics.uvIndex ? `${metrics.uvIndex.risk} — ${metrics.uvIndex.description}` : undefined
            },
            {label: 'Solar Radiation', icon: 'brightness_7', value: observation.solarRadiation ?? NO_READING, unit: 'W/m²'},
            {
                label: 'Rainfall',
                icon: 'water_drop',
                value: readings.rainfall(observation).millimetres,
                unit: 'mm',
                note: 'Total so far today'
            },
            {
                label: 'Precipitation Rate',
                icon: 'grain',
                value: readings.precipitationRate(observation).rate,
                unit: 'mm/hr'
            }
        ];

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
    renderStationView(entry) {
        const observation = entry.observation;
        const key = entry.station.key;
        const uk = observation.uk_hybrid ?? {};
        const wind = readings.wind(observation);

        return `
            <div class="view" id="panel-${key}" role="tabpanel" tabindex="0"
                 aria-labelledby="tab-${key}" data-view="${key}" hidden>
                <section class="wind-card">
                    <div class="wind-dial">
                        ${this.renderWindsock(wind, uk.windSpeed)}
                        <p class="wind-cardinal">${wind.cardinal}</p>
                    </div>

                    <div class="wind-body">
                        <span class="label"><span class="label-icon" aria-hidden="true">air</span>Wind</span>

                        <p class="wind-speed">${wind.speed}<span class="unit">km/h</span></p>

                        ${wind.gusting
                            ? `<p class="wind-gust">Gusting to <strong>${wind.gust} km/h</strong></p>`
                            : ''}
                    </div>
                </section>

                ${this.renderReadouts(observation, entry.metrics)}
                ${trends.render(entry.station)}
            </div>`;
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
        clearTimeout(this.refreshTimer);

        this.refreshTimer = setTimeout(
            () => this.processWeather(),
            sites.refreshMs(site.stations)
        );
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
                this.scheduleRefresh(site);
                return;
            }

            const offline = loaded.filter(entry => !entry.online).map(entry => entry.station.name);
            const notice = offline.length
                ? `<p class="notice">${offline.join(' and ')} ${offline.length > 1 ? 'are' : 'is'} offline. Showing the ${
                    enabled.length > 1 ? 'remaining stations' : 'one station still reporting'
                }.</p>`
                : '';

            // Which tab the reader was on, so a refresh does not send them back
            // to the first station mid-read.
            const selected = document.querySelector('.tab[aria-selected="true"]')?.dataset.view;
            const hadFocus = document.activeElement?.classList.contains('tab');

            weatherDataContainer.innerHTML =
                notice +
                this.renderTabs(loaded) +
                enabled.map(entry => this.renderStationView(entry)).join('');

            this.renderMasthead(loaded);

            // Before the tabs, so the panel revealed by activateView already
            // has a chart to size.
            trends.mount(enabled);

            const lookup = Object.fromEntries(enabled.map(entry => [entry.station.key, entry]));
            this.bindTabs(enabled, lookup, selected);

            if (hadFocus) {
                document.querySelector('.tab[aria-selected="true"]')?.focus();
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

            // Keep trying: a failed load must not end the refresh loop.
            clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => this.processWeather(), RETRY_MS);
        }
    }
}

// Export a default instance of the Index class
const index = new Index();
export default index;
