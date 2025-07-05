import weather from './weather.js';

/**
 * Class for handling live page functionality
 */
export class Live {
    /**
     * Initialize the live page
     * @returns {Promise<void>}
     */
    async initialize() {
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
     * Refresh the iframe to ensure the stream is up to date
     */
    refreshIframe() {
        const iframe = document.getElementById("video-player");
        const src = iframe.src;
        iframe.src = "";
        setTimeout(() => iframe.src = src, 100); // slight delay ensures reload
    }

    /**
     * Load and display weather data in the overlay
     * @returns {Promise<void>}
     */
    async loadAndDisplayWeatherOverlay() {
        try {
            const launchLocation = 'ILUMBY7';
            const groundLocation = 'ILUMBY2';
            const weatherData = await weather.loadWeatherData(launchLocation, groundLocation, 60 * 10);

            if (weatherData && weatherData.observation) {
                const observation = weatherData.observation;

                // Update the wind direction
                const windDirectionElement = document.querySelector('#wind-direction .weather-value');
                windDirectionElement.textContent = `${weather.degreesToDirection(observation.winddir)}`;

                const windIconElement = document.querySelector('#wind-direction .weather-icon');
                windIconElement.style = `transform: rotate(${observation.winddir + 180}deg);`;

                // Update wind speed/gust
                const windSpeedElement = document.querySelector('#wind-speed .weather-value');
                windSpeedElement.textContent = `${observation.uk_hybrid.windSpeed} km/h (${observation.uk_hybrid.windGust} km/h)`;

                // Update rainfall
                const rainfallElement = document.querySelector('#rainfall .weather-value');
                rainfallElement.textContent = `${observation.uk_hybrid.precipTotal} mm`;

                // Update lapse rate
                const lapseRateElement = document.querySelector('#lapse-rate .weather-value');
                lapseRateElement.textContent = `${weatherData.lapseRateInfo.lapseRate} ºC/1000 ft`;

                // Update lapse rate title
                const lapseRateTitleElement = document.querySelector('#lapse-rate .weather-title');
                lapseRateTitleElement.textContent = `Lapse Rate: (${weatherData.lapseRateInfo.elevDiff}ft)`;
            }
        } catch (error) {
            console.error("Error updating weather overlay:", error);
        }
    }
}

// Export a default instance of the Live class
const live = new Live();
export default live;