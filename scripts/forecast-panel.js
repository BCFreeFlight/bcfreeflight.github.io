import {Windgram} from './windgram.js';
import {FORECAST_STRIPS} from './config/rasp.js';
import {buildForecastWindgram} from './rasp-model.js';
import forecast from './forecast.js';

/**
 * The forecast section on a site's weather page.
 *
 * "Today so far" is the day that has happened, drawn from what the stations on
 * the hillside actually recorded. This is the day that has not: the same
 * drawing, from the same model the Canadian RASP runs on, for today and
 * tomorrow. Kept as a separate section rather than as a fourth view of the
 * first, because the difference between a reading and a forecast is the most
 * important thing about either of them and a tab would hide it.
 *
 * Only the launch gets one. The other stations on a hillside sit in the same
 * grid square and would be handed the identical forecast, which would read as
 * three forecasts that happen to agree.
 */

/** How the drawing is labelled when it cannot be drawn. */
const EMPTY = 'No forecast for this day yet.';

/**
 * The barbs sit a little clear of the ground row rather than on it, so the
 * lowest one is not half-buried in the terrain. Small, because unlike the
 * measured drawing there are no station rules to clear — just the ground.
 */
const BARB_OFFSET_FEET = 200;

/**
 * What the forecast has to admit about itself.
 * @param {Object} model - The model being drawn
 * @param {string} zone - The clock the hours are on
 * @returns {string[]} The sentences to print, in order
 */
function footnotes(model, zone) {
    return [
        `Local lapse rate in ºC per 1000 ft. Wind barbs in km/h. Time${zone}. Ground level ${
            Math.round(model.ground)} m asl.`,
        'Forecast, not measured: every number here is from Environment Canada\'s HRDPS model, which is the model the Canadian RASP is built on, read at this launch\'s own coordinates.',
        'Blue hatching is air within half a degree of its dew point. The solid line is where a thermal stops climbing; the dashed line under it is where the climb drops below a glider\'s own sink, and it stops at cloudbase.',
        'Thermals are released from the ground temperature the model forecasts, with no trigger offset, and the climb rate uses the model\'s own surface heat fluxes — the same method the RASP uses, with the same constants.'
    ];
}

export class ForecastPanel {
    constructor() {
        this.windgram = null;
        this.models = {};
        this.day = 0;
        this.station = null;
    }

    /**
     * The markup the section is built into.
     * @param {Object} station - A normalised station
     * @returns {string} HTML markup
     */
    render(station) {
        return `
            <section class="forecast" data-forecast="${station.key}">
                <div class="trend-head">
                    <span class="label">
                        <span class="label-icon" aria-hidden="true">calendar_month</span>Forecast
                    </span>

                    <div class="trend-modes" role="group" aria-label="Forecast day">
                        <button class="trend-mode" type="button" data-day="0"
                                aria-pressed="${this.day === 0}">Today</button>
                        <button class="trend-mode" type="button" data-day="1"
                                aria-pressed="${this.day === 1}">Tomorrow</button>
                    </div>
                </div>

                <div class="forecast-host"></div>
                <p class="trend-note">Reading the forecast…</p>
            </section>`;
    }

    /**
     * Takes ownership of the section just written to the page.
     *
     * Called after every refresh, because the page rebuilds its markup wholesale
     * and the old elements are gone. The models are kept, so a refresh never
     * blanks a drawing the reader is looking at.
     *
     * @param {?Object} entry - The launch station's entry, when it has one
     * @returns {void}
     */
    mount(entry) {
        this.windgram?.destroy();
        this.windgram = null;

        const station = entry?.station;
        const host = station
            ? document.querySelector(`.forecast[data-forecast="${station.key}"]`)
            : null;

        if (!host) return;

        this.station = station;
        this.host = host;
        this.note = host.querySelector('.trend-note');
        this.windgram = new Windgram(host.querySelector('.forecast-host'), {
            strips: FORECAST_STRIPS,
            barbOffsetFeet: BARB_OFFSET_FEET,
            empty: EMPTY,
            smooth: true,
            footnotes
        });

        this.bind();

        // Already drawn from whatever was read last time, so switching tabs is
        // instant and a refresh does not blank the panel.
        if (this.models[this.day]) this.apply();

        // Deliberately not awaited: the readings are already on screen and the
        // forecast fills in underneath them.
        this.load(entry);
    }

    /**
     * The Today and Tomorrow buttons.
     * @returns {void}
     */
    bind() {
        this.host.addEventListener('click', event => {
            const button = event.target.closest('.trend-mode');
            if (!button) return;

            this.day = Number(button.dataset.day);
            this.apply();
        });
    }

    /**
     * Reads the forecast and builds both days from it.
     * @param {Object} entry - The launch station's entry
     * @returns {Promise<void>}
     */
    async load(entry) {
        const {latitude, longitude} = this.coordinates(entry);

        const read = await forecast.load(latitude, longitude);

        // The section may have been rebuilt under us while this was in flight.
        if (!this.windgram) return;

        this.models = {
            0: buildForecastWindgram(read, {day: 0, latitude, longitude}),
            1: buildForecastWindgram(read, {day: 1, latitude, longitude})
        };

        this.apply();
    }

    /**
     * Where the forecast is asked about.
     *
     * The station's own coordinates from the site's JSON, which name the launch
     * itself. The observation's are a fallback and are the ones Weather
     * Underground holds for the sensor, which is not always where it says.
     *
     * @param {Object} entry - The launch station's entry
     * @returns {Object} latitude and longitude
     */
    coordinates(entry) {
        const named = entry.station.coordinates;

        return {
            latitude: named?.latitude ?? Number(entry.observation?.lat),
            longitude: named?.longitude ?? Number(entry.observation?.lon)
        };
    }

    /**
     * Draws the selected day and marks its button.
     * @returns {void}
     */
    apply() {
        if (!this.windgram) return;

        this.host.querySelectorAll('.trend-mode').forEach(button => {
            button.setAttribute('aria-pressed', String(Number(button.dataset.day) === this.day));
        });

        const model = this.models[this.day] ?? null;

        this.windgram.setModel(model);
        this.note.hidden = Boolean(model);
        if (!model) this.note.textContent = EMPTY;
    }

    /**
     * Redraws once the section is on a visible tab.
     *
     * A drawing sized while its panel was hidden has no width to size against,
     * so it draws nothing and waits to be told it is visible.
     *
     * @param {string} key - The station whose panel was just shown
     * @returns {void}
     */
    reveal(key) {
        if (this.station?.key === key) this.windgram?.scheduleDraw();
    }
}

const forecastPanel = new ForecastPanel();
export default forecastPanel;
