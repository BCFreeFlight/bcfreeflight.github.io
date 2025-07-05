import time from './time.js';
import weather from './weather.js';

/**
 * Class for handling index page functionality
 */
export class Index {
    /**
     * Process and display weather data
     * @returns {Promise<void>}
     */
    async processWeather() {
        const weatherDataContainer = document.getElementById('weather-data');
        const lastUpdatedElement = document.getElementById('last-updated');
        const locationElement = document.getElementById('location');
        try {
            const launchLocation = 'ILUMBY7';
            const groundLocation = 'ILUMBY2';
            const weatherData = await weather.loadWeatherData(launchLocation, groundLocation);

            // Update last updated time
            const lastUpdated = new Date(weatherData.observation.obsTimeUtc);

            lastUpdatedElement.textContent = `Last updated: ${time.format(lastUpdated)}`;
            locationElement.textContent = `Location: ${weatherData.observation.lat.toFixed(3)}, ${weatherData.observation.lon.toFixed(3)} at ${weatherData.observation.uk_hybrid.elev} ft`;
            // Clear loading indicator
            weatherDataContainer.innerHTML = '';
            if (weatherData && weatherData.observation) {

                // Create weather cards
                const weatherItems = [
                    {
                        title: 'Wind Direction',
                        value: `${weather.degreesToDirection(weatherData.observation.winddir)}`,
                        icon: 'navigation',
                        style: `transform: rotate(${weatherData.observation.winddir + 180}deg);`,
                        background: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${weatherData.observation.lon},${weatherData.observation.lat},14/600x400?access_token=pk.eyJ1IjoiY2hhc2VmbG9yZWxsIiwiYSI6ImNtYmN4bXJnNzEza2cyam42MWNwNmJ5cmIifQ.40BZbxanvherUlpc4RdoFw`,
                        backgroundType: 'image'
                    },
                    {
                        title: 'Wind Speed (Gust)',
                        value: `${weatherData.observation.uk_hybrid.windSpeed} km/h (${weatherData.observation.uk_hybrid.windGust} km/h)`,
                        icon: 'air'
                    },
                    {
                        title: `Lapse Rate: (${weatherData.lapseRateInfo.elevDiff}ft)`,
                        value: weatherData.lapseRateInfo.lapseRate ? `${weatherData.lapseRateInfo.lapseRate} °C/1000 ft` : 'N/A',
                        icon: 'elevation',
                        background: weatherData.lapseRateInfo.details.color,
                        backgroundType: 'color',
                        summary: `${weatherData.lapseRateInfo.details.name}`
                    },
                    {
                        title: 'Temperature',
                        value: `${weatherData.observation.uk_hybrid.temp}ºC`,
                        icon: 'device_thermostat'
                    },
                    {
                        title: 'Rainfall',
                        value: `${weatherData.observation.uk_hybrid.precipTotal} mm`,
                        icon: 'water_drop'
                    },
                    {
                        title: 'Humidity',
                        value: `${weatherData.humidity.percent}%`,
                        icon: 'humidity_percentage',
                        summary: `${weatherData.humidity.description}`
                    },
                    {
                        title: 'Heat Index',
                        value: `${weatherData.heatIndex.celsius}ºC`,
                        icon: 'wb_sunny',
                        summary: `${weatherData.heatIndex.description}`
                    },
                    {
                        title: 'Dew Point',
                        value: `${weatherData.dewPoint.celsius}ºC`,
                        icon: 'opacity',
                        summary: `${weatherData.dewPoint.description}`
                    },
                    {
                        title: 'Wind Chill',
                        value: `${weatherData.windChill.celsius}ºC`,
                        icon: 'ac_unit',
                        summary: `${weatherData.windChill.description}`
                    },
                    {
                        title: 'Barometric Pressure',
                        value: `${weatherData.barometricPressure.kPa} kPa`,
                        icon: 'speed',
                        summary: `${weatherData.barometricPressure.description}`
                    },
                    {
                        title: 'UV Index',
                        value: `${weatherData.observation.uv}`,
                        icon: 'light_mode',
                        summary: `${weatherData.uvIndex.risk}, (${weatherData.uvIndex.description})`
                    },
                    {
                        title: 'Solar Radiation',
                        value: `${weatherData.observation.solarRadiation} W/m²`,
                        icon: 'brightness_7'
                    },
                    {
                        title: 'Precipitation Rate',
                        value: `${weatherData.observation.uk_hybrid.precipRate} mm/hr`,
                        icon: 'grain'
                    }
                ];

                // Render weather cards
                weatherItems.forEach(item => {
                    const cardCol = document.createElement('div');
                    cardCol.className = 'col-6 col-md-3 mb-4';

                    cardCol.innerHTML = `
                        <div class="card weather-card shadow-sm h-100">
                            <div class="card-header text-center fw-bold">
                                ${item.title}
                            </div>

                            <div class="card-body text-center d-flex flex-column justify-content-between"
                                ${item.background ?
                        item.backgroundType === 'image'
                            ? `style="background-image: url('${item.background}'); background-size: cover; background-position: center;"`
                            : item.backgroundType === 'color'
                                ? `style="background-color: ${item.background};"`
                                : ''
                        : ''}>

                                <div class="flex-grow-1 d-flex justify-content-center align-items-start">
                                    <span class="material-symbols-outlined weather-icon" style="${item.style ?? ''}">${item.icon}</span>
                                </div>

                                <div class="mt-auto">
                                    <h2 class="card-text text-regular">${item.value}</h2>
                                    ${item.summary ? `<div class="card-subtext text-muted small">${item.summary}</div>` : ''}
                                </div>
                            </div>
                        </div>
                    `;

                    weatherDataContainer.appendChild(cardCol);
                });

            } else {
                weatherDataContainer.innerHTML = `
                    <div class="col-12 text-center">
                        <div class="alert alert-warning" role="alert">
                            No weather data available, please try again later.</br>
                            In the meantime, try <a href="https://wunderground.com/dashboard/pws/${launchLocation}" target="_blank">this link</a>
                        </div>
                    </div>
                `;
            }

        } catch (error) {
            console.error("Error in weather app:", error);
            weatherDataContainer.innerHTML = `
                <div class="col-12 text-center">
                    <div class="alert alert-danger" role="alert">
                        Failed to load weather data. Please try again later.
                    </div>
                </div>
            `;
        }
    }
}

// Export a default instance of the Index class
const index = new Index();
export default index;
