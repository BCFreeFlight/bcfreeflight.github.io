import time from './time.js';
import weather from './weather.js';
import * as readings from './readings.js';

// Bounds of the lapse-rate scale, in °C per 1000 ft.
const LAPSE_MIN = -4;
const LAPSE_MAX = 2;

// Top of the wind bar, in km/h. Anything faster pins the bar full.
const WIND_SCALE = 40;

// Speed at which the windsock reads fully extended, in km/h.
const WINDSOCK_FULL = 20;

const LAUNCH_STATION = 'ILUMBY7';
const GROUND_STATION = 'ILUMBY8';

const NO_READING = readings.NO_READING;

/**
 * Class for handling index page functionality
 */
export class Index {
    /**
     * Build the windsock that sits on the dial. Its mouth faces the wind and the
     * tail streams downwind, the way a real sock hangs. The sock also fills out
     * with speed: limp and short when calm, fully extended by WINDSOCK_FULL.
     * @param {number} rotation - Bearing the tail should stream towards, in degrees
     * @param {?number} windSpeed - Wind speed in km/h
     * @returns {string} SVG markup
     */
    renderWindsock(rotation, windSpeed) {
        const cx = 120, cy = 120;
        const fullLength = 116;

        // Fraction of full extension, so a calm sock reads as a stubby cone.
        const extension = 0.42 + 0.58 * Math.min((windSpeed ?? 0) / WINDSOCK_FULL, 1);
        const length = fullLength * extension;

        // Straddle the hub, so a short sock stays centred instead of drifting upwind.
        const mouthY = cy + length / 2;

        const mouthHalf = 17;
        const tailHalf = 7;
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
            <g class="windsock" style="transform: rotate(${rotation}deg); transform-origin: ${cx}px ${cy}px;">
                ${bands}
                <ellipse cx="${cx}" cy="${mouthY}" rx="${mouthHalf}" ry="4"
                         fill="#ee6a10" stroke="#16202b" stroke-opacity=".35" stroke-width="1"/>
            </g>`;
    }

    /**
     * Build the wind rose: a fixed compass card carrying the windsock.
     * Ticks every 10°, cardinals at the quarters.
     * @param {Object} wind - A shared wind reading: cardinal, bearing, rotation
     * @param {?number} windSpeed - Wind speed in km/h
     * @returns {string} SVG markup
     */
    renderRose(wind, windSpeed) {
        const cx = 120, cy = 120;
        const bearing = wind.bearing;
        let ticks = '';

        for (let deg = 0; deg < 360; deg += 10) {
            const major = deg % 30 === 0;
            const outer = 104;
            const inner = major ? 94 : 99;
            const rad = (deg - 90) * Math.PI / 180;
            ticks += `<line x1="${cx + Math.cos(rad) * inner}" y1="${cy + Math.sin(rad) * inner}"
                            x2="${cx + Math.cos(rad) * outer}" y2="${cy + Math.sin(rad) * outer}"
                            stroke="${major ? '#c3bcae' : '#ddd8ce'}" stroke-width="${major ? 1.5 : 1}"/>`;
        }

        const cardinals = [['N', 0], ['E', 90], ['S', 180], ['W', 270]]
            .map(([letter, deg]) => {
                const rad = (deg - 90) * Math.PI / 180;
                return `<text x="${cx + Math.cos(rad) * 78}" y="${cy + Math.sin(rad) * 78}"
                              text-anchor="middle" dominant-baseline="central"
                              font-family="Archivo, sans-serif" font-size="13" font-weight="600"
                              letter-spacing="1" fill="#66707c">${letter}</text>`;
            }).join('');

        return `
            <svg class="rose" viewBox="0 0 240 240" role="img"
                 aria-label="Wind from ${wind.cardinal}, ${bearing} degrees">
                <circle cx="${cx}" cy="${cy}" r="104" fill="#fbfaf7" stroke="#ddd8ce"/>
                <circle cx="${cx}" cy="${cy}" r="62" fill="none" stroke="#ddd8ce" stroke-dasharray="2 5"/>
                ${ticks}
                ${cardinals}
                ${this.renderWindsock(wind.rotation, windSpeed)}
            </svg>`;
    }

    /**
     * Build the banded lapse-rate scale with a marker at the current value.
     * Band colours are the same stability bands used elsewhere in the app.
     * @param {?number} lapseRate - Lapse rate in °C per 1000 ft, or null
     * @returns {string} HTML markup
     */
    renderLapseScale(lapseRate) {
        const span = LAPSE_MAX - LAPSE_MIN;
        let lower = LAPSE_MIN;

        const bands = weather.lapseSummaries.map(band => {
            const upper = Math.min(band.max === Infinity ? LAPSE_MAX : band.max, LAPSE_MAX);
            const width = Math.max(0, upper - lower) / span * 100;
            lower = upper;
            return `<span class="lapse-band" style="flex-grow: ${width}; background: ${band.color};"></span>`;
        }).join('');

        const marker = lapseRate === null
            ? ''
            : `<span class="lapse-marker" style="left: ${(Math.min(Math.max(lapseRate, LAPSE_MIN), LAPSE_MAX) - LAPSE_MIN) / span * 100}%;"></span>`;

        return `
            <div class="lapse-scale${lapseRate === null ? ' is-idle' : ''}">${bands}${marker}</div>
            <div class="lapse-ends"><span>${LAPSE_MIN} unstable</span><span>inverted +${LAPSE_MAX}</span></div>`;
    }

    /**
     * The lapse-rate summary. It measures the pair of stations rather than
     * either one, so it belongs beside the site name rather than inside a
     * station's tab, and it carries its own unavailable state.
     * @param {Object} lapseRateInfo - Lapse rate info from the weather service
     * @param {Object} stations - Per-station online flags
     * @returns {string} HTML markup
     */
    renderLapseSummary(lapseRateInfo, stations) {
        const lapse = readings.lapse(lapseRateInfo);
        const missing = [stations.launch, stations.ground].filter(s => s.id && !s.online);

        if (!lapse.available) {
            return `
                <span class="label"><span class="label-icon" aria-hidden="true">elevation</span>Lapse rate</span>
                <div class="lapse-head">
                    <p class="lapse-value is-empty">${NO_READING}</p>
                    <p class="lapse-note">Needs both stations reporting.${
                        missing.length ? ` ${missing.map(s => s.id).join(' and ')} is offline.` : ''
                    }</p>
                </div>
                ${this.renderLapseScale(null)}`;
        }

        return `
            <span class="label"><span class="label-icon" aria-hidden="true">elevation</span>Lapse rate &middot; ${lapse.elevDiff.toLocaleString()} ft launch to LZ</span>
            <div class="lapse-head">
                <p class="lapse-value">${lapse.rate}<span class="unit">ºC/1000 ft</span></p>
                <p class="lapse-note"><span class="lapse-name">${lapse.name}</span><br>${lapse.description}</p>
            </div>
            ${this.renderLapseScale(lapse.rate)}`;
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
     * @param {Object} view - A station view: key, observation, metrics
     * @returns {string} HTML markup
     */
    renderStationView(view) {
        const observation = view.observation;
        const uk = observation.uk_hybrid ?? {};
        const wind = readings.wind(observation);

        const speedPct = Math.min((uk.windSpeed ?? 0) / WIND_SCALE, 1) * 100;
        const gustPct = Math.min((uk.windGust ?? 0) / WIND_SCALE, 1) * 100;

        return `
            <div class="view" id="panel-${view.key}" role="tabpanel" tabindex="0"
                 aria-labelledby="tab-${view.key}" data-view="${view.key}" hidden>
                <section class="panel">
                    <div class="rose-cell">
                        ${this.renderRose(wind, uk.windSpeed)}
                    </div>

                    <div class="stat-cell">
                        <span class="label"><span class="label-icon" aria-hidden="true">air</span>Wind</span>

                        <p class="stat-value">
                            ${wind.cardinal}
                            <span class="stat-bearing">${wind.bearing}°</span>
                        </p>

                        <p class="stat-value stat-value--speed">${wind.speed}<span class="unit">km/h</span></p>

                        <div class="gust-track">
                            <span class="gust-fill" style="width: ${gustPct}%"></span>
                            <span class="speed-fill" style="width: ${speedPct}%"></span>
                        </div>
                        <div class="gust-scale"><span>0</span><span>${WIND_SCALE}+ km/h</span></div>
                        <p class="stat-note">Gusting to <strong>${wind.gust} km/h</strong></p>
                    </div>
                </section>

                ${this.renderReadouts(observation, view.metrics)}
            </div>`;
    }

    /**
     * The station switcher. Offline stations stay listed but disabled, so the
     * page says which station is missing rather than hiding it.
     * @param {Object[]} views - Every station, online or not
     * @returns {string} HTML markup
     */
    renderTabs(views) {
        return `
            <div class="tabs" role="tablist" aria-label="Weather station">
                ${views.map(view => `
                    <button class="tab" type="button" role="tab" id="tab-${view.key}"
                            aria-controls="panel-${view.key}" aria-selected="false"
                            data-view="${view.key}" tabindex="-1"
                            ${view.observation ? '' : 'disabled'}>
                        <span class="tab-name">${view.name}</span>
                        <span class="tab-meta">${view.station.id}${
                            view.observation
                                ? ` &middot; ${Number(view.observation.uk_hybrid.elev).toLocaleString()} ft`
                                : ' &middot; offline'
                        }</span>
                    </button>`).join('')}
            </div>`;
    }

    /**
     * Shows one station's panel and updates the masthead to match it.
     * @param {string} key - The view key to activate
     * @param {Object} lookup - View key to its observation and station id
     * @returns {void}
     */
    activateView(key, lookup) {
        const lastUpdatedElement = document.getElementById('last-updated');
        const locationElement = document.getElementById('location');

        document.querySelectorAll('.tab').forEach(tab => {
            const selected = tab.dataset.view === key;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
        });

        document.querySelectorAll('.view').forEach(panel => {
            panel.hidden = panel.dataset.view !== key;
        });

        const active = lookup[key];
        const uk = active.observation.uk_hybrid ?? {};
        lastUpdatedElement.textContent = time.format(new Date(active.observation.obsTimeUtc));
        locationElement.innerHTML =
            `${active.observation.lat.toFixed(3)}, ${active.observation.lon.toFixed(3)}<span class="sep">/</span>` +
            `${Number(uk.elev).toLocaleString()} ft<span class="sep">/</span>${active.station.id}`;
    }

    /**
     * Wires clicks and left/right arrow keys on the station switcher.
     * @param {Object[]} enabled - The views that have data
     * @param {Object} lookup - View key to its observation and station id
     * @returns {void}
     */
    bindTabs(enabled, lookup) {
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

        this.activateView(enabled[0].key, lookup);
    }

    /**
     * Process and display weather data
     * @returns {Promise<void>}
     */
    async processWeather() {
        const weatherDataContainer = document.getElementById('weather-data');
        const lastUpdatedElement = document.getElementById('last-updated');

        try {
            const data = await weather.loadWeatherData(LAUNCH_STATION, GROUND_STATION);
            const stations = data.stations;

            const views = [
                {
                    key: 'launch',
                    name: 'Launch',
                    station: stations.launch,
                    observation: data.observation,
                    metrics: data
                },
                {
                    key: 'ground',
                    name: 'Landing zone',
                    station: stations.ground,
                    observation: data.groundObservation,
                    metrics: data.groundMetrics
                }
            ];

            // Whichever stations answered. One being dark never hides the other.
            const enabled = views.filter(view => view.observation);

            if (!enabled.length) {
                lastUpdatedElement.textContent = 'no signal';
                weatherDataContainer.innerHTML = `
                    <div class="state">
                        <p class="state-title">Both stations are dark</p>
                        <p>Neither ${LAUNCH_STATION} nor ${GROUND_STATION} is reporting. Try
                           <a href="https://wunderground.com/dashboard/pws/${LAUNCH_STATION}" target="_blank" rel="noopener">the launch station on Weather Underground</a>.</p>
                    </div>`;
                return;
            }

            const notice = enabled.length < views.length
                ? `<p class="notice">${views.find(v => !v.observation).station.id} is offline. Showing ${enabled[0].station.id} only.</p>`
                : '';

            weatherDataContainer.innerHTML =
                notice +
                this.renderTabs(views) +
                enabled.map(view => this.renderStationView(view)).join('');

            // Belongs to the pair of stations, so it sits outside the tabs.
            document.getElementById('lapse-summary').innerHTML =
                this.renderLapseSummary(data.lapseRateInfo, stations);

            const lookup = Object.fromEntries(enabled.map(view => [view.key, view]));
            this.bindTabs(enabled, lookup);

        } catch (error) {
            console.error("Error in weather app:", error);
            weatherDataContainer.innerHTML = `
                <div class="state">
                    <p class="state-title">Couldn't reach the stations</p>
                    <p>The weather service didn't answer. Reload in a minute.</p>
                </div>`;
        }
    }
}

// Export a default instance of the Index class
const index = new Index();
export default index;
