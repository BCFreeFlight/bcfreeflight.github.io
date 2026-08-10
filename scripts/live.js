import weather from './weather.js';
import * as readings from './readings.js';

// Remembered across the page's own periodic reloads.
const VIEW_KEY = 'live_view_mode';
const WEATHER_KEY = 'live_weather_visible';

/**
 * Class for handling live page functionality
 */
export class Live {
    /**
     * Initialize the live page
     * @returns {Promise<void>}
     */
    async initialize() {
        this.setupViewControls();
        this.setupDragToPan();

        // Initial data load
        await this.loadAndDisplayWeatherOverlay();
        // Set up an automatic refresh every 5 minutes
        setInterval(() => this.loadAndDisplayWeatherOverlay(), 5 * 60 * 1000);
        // Refresh every hour (3_600_000 milliseconds)
        setInterval(() => this.refreshIframe(), 60 * 60 * 1000);
        // Refresh the whole page every 8 hours just in case something got balled up.
        // This can also help purge old scripts and ensure the stream is always up to date.
        setTimeout(() => {
            // Appends a cache-busting query param to ensure a fresh fetch
            window.location.href = window.location.pathname + '?cb=' + Date.now();
        }, 8 * 60 * 60 * 1000);

        // Refresh when page becomes active (e.g., tab is focused)
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") {
                this.refreshIframe();
            }
        });
    }

    /**
     * Reads a remembered preference, tolerating a blocked or full localStorage.
     * @param {string} key - Storage key
     * @param {string} fallback - Value to use when nothing is stored
     * @returns {string} The stored value, or the fallback
     */
    readPreference(key, fallback) {
        try {
            return localStorage.getItem(key) ?? fallback;
        } catch (error) {
            return fallback;
        }
    }

    /**
     * Stores a preference, ignoring failures so a private-mode browser still works.
     * @param {string} key - Storage key
     * @param {string} value - Value to store
     * @returns {void}
     */
    writePreference(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            // A preference that cannot be saved is not worth interrupting playback for.
        }
    }

    /**
     * Wires the two overlay buttons: one crops the video to fill the screen or
     * fits the whole frame, the other shows or hides the weather readings.
     * @returns {void}
     */
    setupViewControls() {
        const viewButton = document.getElementById('toggle-view');
        const weatherButton = document.getElementById('toggle-weather');

        if (!viewButton || !weatherButton) return;

        const applyView = mode => {
            document.body.dataset.view = mode;
            const filling = mode === 'fill';

            // The button offers the mode you are not in.
            viewButton.setAttribute('aria-pressed', String(!filling));
            viewButton.querySelector('.material-symbols').textContent =
                filling ? 'fit_screen' : 'zoom_out_map';
            viewButton.querySelector('.visually-hidden').textContent =
                filling ? 'Show the whole frame' : 'Fill the screen';

            if (filling) {
                this.centreVideo();
            } else {
                requestAnimationFrame(() => this.markPannable());
            }
        };

        const applyWeather = visible => {
            document.body.dataset.weather = visible ? 'shown' : 'hidden';
            weatherButton.setAttribute('aria-pressed', String(visible));
            // The chevron points the way the readings will travel.
            weatherButton.querySelector('.material-symbols').textContent =
                visible ? 'expand_more' : 'expand_less';
            weatherButton.querySelector('.visually-hidden').textContent =
                visible ? 'Hide the weather readings' : 'Show the weather readings';
        };

        applyView(this.readPreference(VIEW_KEY, 'fill'));
        applyWeather(this.readPreference(WEATHER_KEY, 'shown') === 'shown');

        viewButton.addEventListener('click', () => {
            const mode = document.body.dataset.view === 'fill' ? 'fit' : 'fill';
            this.writePreference(VIEW_KEY, mode);
            applyView(mode);
        });

        weatherButton.addEventListener('click', () => {
            const visible = document.body.dataset.weather !== 'shown';
            this.writePreference(WEATHER_KEY, visible ? 'shown' : 'hidden');
            applyWeather(visible);
        });

        // Rotating the device changes which axis overflows, and on iOS the new
        // dimensions are not settled when orientationchange fires — hence both
        // events, and the delayed second pass.
        const recentre = () => {
            if (document.body.dataset.view !== 'fill') return;
            this.centreVideo();
            setTimeout(() => this.centreVideo(), 300);
        };

        window.addEventListener('resize', recentre);
        window.addEventListener('orientationchange', recentre);
    }

    /**
     * Parks the cropped video on its middle, so panning starts from centre
     * rather than from one edge of the frame.
     * @returns {void}
     */
    centreVideo() {
        const mask = document.querySelector('.video-mask');
        if (!mask) return;

        requestAnimationFrame(() => {
            mask.scrollLeft = (mask.scrollWidth - mask.clientWidth) / 2;
            mask.scrollTop = (mask.scrollHeight - mask.clientHeight) / 2;
            this.markPannable();
        });
    }

    /**
     * Flags whether the frame currently overflows, which drives the grab cursor.
     * @returns {void}
     */
    markPannable() {
        const mask = document.querySelector('.video-mask');
        if (!mask) return;

        const pannable = mask.scrollWidth > mask.clientWidth || mask.scrollHeight > mask.clientHeight;
        document.body.dataset.pannable = String(pannable);
    }

    /**
     * Drag-to-pan for a mouse. Touch is left to the browser's own scrolling so
     * it keeps its momentum, and the iframe's pointer-events: none is what lets
     * these events reach the container at all.
     * @returns {void}
     */
    setupDragToPan() {
        const mask = document.querySelector('.video-mask');
        if (!mask) return;

        let origin = null;

        mask.addEventListener('pointerdown', event => {
            if (event.pointerType !== 'mouse' || event.button !== 0) return;

            origin = {
                x: event.clientX,
                y: event.clientY,
                left: mask.scrollLeft,
                top: mask.scrollTop
            };

            mask.setPointerCapture(event.pointerId);
            mask.classList.add('is-dragging');
            event.preventDefault();
        });

        mask.addEventListener('pointermove', event => {
            if (!origin) return;

            mask.scrollLeft = origin.left - (event.clientX - origin.x);
            mask.scrollTop = origin.top - (event.clientY - origin.y);
        });

        const release = event => {
            if (!origin) return;

            origin = null;
            mask.classList.remove('is-dragging');

            if (mask.hasPointerCapture(event.pointerId)) {
                mask.releasePointerCapture(event.pointerId);
            }
        };

        mask.addEventListener('pointerup', release);
        mask.addEventListener('pointercancel', release);
    }

    /**
     * Refresh the iframe to ensure the stream is up to date
     */
    refreshIframe() {
        const iframe = document.getElementById("video-player");
        const src = iframe.src;
        iframe.src = "";
        setTimeout(() => {
            iframe.src = src; // slight delay ensures reload
            if (document.body.dataset.view === 'fill') this.centreVideo();
        }, 100);
    }

    /**
     * Writes one tile's value, and its title when the tile carries a live one.
     * @param {string} selector - The tile's container selector
     * @param {string} value - The reading to show
     * @param {?string} [title] - Replacement title, when it varies with the data
     * @returns {void}
     */
    setReading(selector, value, title = null) {
        const tile = document.querySelector(selector);
        if (!tile) return;

        tile.querySelector('.weather-value').textContent = value;

        if (title !== null) {
            tile.querySelector('.weather-title').textContent = title;
        }
    }

    /**
     * Load and display weather data in the overlay
     * @returns {Promise<void>}
     */
    async loadAndDisplayWeatherOverlay() {
        try {
            const launchLocation = 'ILUMBY7';
            const groundLocation = 'ILUMBY8';
            const weatherData = await weather.loadWeatherData(launchLocation, groundLocation, 60 * 10);

            if (weatherData && weatherData.observation) {
                const observation = weatherData.observation;

                const wind = readings.wind(observation);
                const lapse = readings.lapse(weatherData.lapseRateInfo);

                // Wind: direction and speed read as one value, gust in the title.
                // The rotation already accounts for the wind blowing *from* the
                // cardinal shown, so the arrow points away from it.
                this.setReading('#wind', wind.summary, wind.gustSummary);
                document.querySelector('#wind .weather-icon').style =
                    `transform: rotate(${wind.rotation}deg);`;

                this.setReading('#temperature', readings.temperature(observation).summary);
                this.setReading('#rainfall', readings.rainfall(observation).summary);
                this.setReading('#lapse-rate', lapse.summary, lapse.title);
            }
        } catch (error) {
            console.error("Error updating weather overlay:", error);
        }
    }
}

// Export a default instance of the Live class
const live = new Live();
export default live;