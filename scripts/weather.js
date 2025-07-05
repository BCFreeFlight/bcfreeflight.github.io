var app = app || {};

/**
 * Class for handling Weather Underground API interactions
 */
class WeatherUnderground {
    /**
     * Retrieves weather data for the specified location, with optional caching support.
     *
     * @param {string} location - The location identifier for which to fetch the weather data.
     * @param {number} [cacheTimeoutSeconds=0] - The time in seconds the data should be considered valid in the cache. Defaults to 0, which disables caching.
     * @return {Promise<Object>} A promise resolving to an object containing the weather data.
     */

    /**
     * @typedef {Object} UkHybrid
     * @property {number} elev - Elevation in feet
     * @property {number} windSpeed - Wind speed in km/h
     * @property {number} windGust - Wind gust in km/h
     * @property {number} temp - Temperature in Celsius
     * @property {number} precipTotal - Total precipitation in mm
     * @property {number} heatIndex - Heat index in Celsius
     * @property {number} dewpt - Dew point in Celsius
     * @property {number} windChill - Wind chill in Celsius
     * @property {number} pressure - Barometric pressure in hPa
     * @property {number} precipRate - Precipitation rate in mm/hr
     */

    /**
     * @typedef {Object} Observation
     * @property {string} obsTimeUtc - Observation time in UTC
     * @property {number} lat - Latitude
     * @property {number} lon - Longitude
     * @property {UkHybrid} uk_hybrid - UK hybrid measurements
     * @property {number} winddir - Wind direction in degrees
     * @property {number} humidity - Humidity percentage
     * @property {number} uv - UV index
     * @property {number} solarRadiation - Solar radiation in W/m²
     */

    /**
     * @typedef {Object} WeatherData
     * @property {Observation[]} observations - Array of weather observations
     */
    async getWeather(location, cacheTimeoutSeconds = 0) {
        const CACHE_KEY = `weather_cache_${location}`;
        const nowUtc = Date.now();

        // Try to get cached data from localStorage
        let cachedData = null;
        try {
            const cachedItem = localStorage.getItem(CACHE_KEY);
            if (cachedItem) {
                cachedData = JSON.parse(cachedItem);
            }
        } catch (error) {
            console.error("Error reading from localStorage:", error);
        }

        if (cachedData && cacheTimeoutSeconds > 0 && cachedData.data.observations[0].obsTimeUtc) {
            const obsTime = Date.parse(cachedData.data.observations[0].obsTimeUtc);
            const ageInSeconds = (nowUtc - obsTime) / 1000;

            if (ageInSeconds < cacheTimeoutSeconds) {
                console.log(`Using cached weather data for ${location} (age: ${Math.round(ageInSeconds)}s, timeout: ${cacheTimeoutSeconds}s)`);
                return cachedData.data;
            }
        }

        // Fetch new data and cache it
        const data = await this._fetchWeatherData(location);

        if (data) {
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify({data}));
            } catch (error) {
                console.error("Error writing to localStorage:", error);
            }
        }

        return data;
    }

    /**
     * Private method to fetch weather data from the API
     * @param {string} location - The location identifier
     * @return {Promise<Object|null>} The weather data or null
     * @private
     */
    async _fetchWeatherData(location) {
        const apiKey = "6dfb9fed05d24b71bb9fed05d20b715d";
        const apiUrl = `https://api.weather.com/v2/pws/observations/current?stationId=${location}&format=json&units=h&numericPrecision=decimal&apiKey=${apiKey}`;
        try {
            const response = await fetch(apiUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error("Error fetching weather data:", error);
            return null;
        }
    }
}

/**
 * Main Weather class for handling weather data and calculations
 */
class Weather {
    constructor() {
        // Initialize the WeatherUnderground instance
        this.weatherUnderground = new WeatherUnderground();

        // Initialize data arrays
        this.directions = [
            {name: "N", min: 348.75, max: 360},
            {name: "N", min: 0, max: 11.25},
            {name: "NNE", min: 11.25, max: 33.75},
            {name: "NE", min: 33.75, max: 56.25},
            {name: "ENE", min: 56.25, max: 78.75},
            {name: "E", min: 78.75, max: 101.25},
            {name: "ESE", min: 101.25, max: 123.75},
            {name: "SE", min: 123.75, max: 146.25},
            {name: "SSE", min: 146.25, max: 168.75},
            {name: "S", min: 168.75, max: 191.25},
            {name: "SSW", min: 191.25, max: 213.75},
            {name: "SW", min: 213.75, max: 236.25},
            {name: "WSW", min: 236.25, max: 258.75},
            {name: "W", min: 258.75, max: 281.25},
            {name: "WNW", min: 281.25, max: 303.75},
            {name: "NW", min: 303.75, max: 326.25},
            {name: "NNW", min: 326.25, max: 348.75}
        ];

        this.lapseSummaries = [
            {name: 'Unstable', max: -3.0, color: '#ff0000', description: 'Strong thermals, turbulent conditions possible'},
            {name: 'Conditional Instability', max: -2.5, color: '#ff8000', description: 'Thermals likely, some instability'},
            {name: 'Conditional Instability', max: -2.0, color: '#ffb6ff', description: 'Weaker thermals developing'},
            {name: 'Conditional Instability', max: -1.5, color: '#dcb7ff', description: 'Marginal thermal lift possible'},
            {name: 'Stable', max: -1.2, color: '#fddbb0', description: 'Mostly smooth air, limited thermal activity'},
            {name: 'Stable', max: -0.5, color: '#8080ff', description: 'Very little thermal activity, smooth flying'},
            {name: 'Stable', max: 0.0, color: '#c0cfff', description: 'Cool and calm, no climb potential'},
            {name: 'Inverted', max: 0.5, color: '#d3d3d3', description: 'Temperature increases with height, suppresses lift'},
            {name: 'Strong Inversion', max: Infinity, color: '#808080', description: 'No lift, capped inversion layer'}
        ];

        this.uvIndexSummaries = [
            {risk: 'None', max: 0, description: 'No risk: no UV exposure'},
            {risk: 'Low', max: 2.9, description: 'Minimal risk: light SPF, sunglasses'},
            {risk: 'Moderate', max: 5.9, description: 'Moderate risk: SPF 30+, hat'},
            {risk: 'High', max: 7.9, description: 'High risk: SPF 30–50, cover up'},
            {risk: 'Very High', max: 10.9, description: 'Very high risk: SPF 50+, cover up'},
            {risk: 'Extreme', max: Infinity, description: 'Extreme risk: Stay indoors'}
        ];

        this.barometricPressureSummaries = [
            {name: 'Very Low', max: 98, description: 'Storms, maybe even severe weather'},
            {name: 'Low', max: 100, description: 'Clouds, wind, likely rain'},
            {name: 'Normal', max: 102, description: 'No big drama'},
            {name: 'High', max: Infinity, description: 'Clear skies, stable weather'},
        ];

        this.dewPointSummaries = [
            {description: "Dry and comfortable", max: 10},
            {description: "Slightly humid yet still pleasant", max: 16},
            {description: "Noticeably muggy, sweat lingers", max: 18},
            {description: "Very uncomfortable, heavy oppressive humidity", max: 21},
            {description: "Oppressively humid, extremely sticky conditions", max: Infinity}
        ];

        this.humiditySummaries = [
            {description: 'Dry air, potential dehydration risk', max: 30},
            {description: 'Comfortable humidity, pleasant conditions', max: 50},
            {description: 'Slight humidity, mild stickiness', max: 60},
            {description: 'Humid air, noticeable discomfort', max: 75},
            {description: 'Very humid, oppressive moisture', max: Infinity}
        ];

        this.heatIndexSummaries = [
            {description: 'Comfortable, minimal heat stress', max: 27},
            {description: 'Caution: some discomfort, stay hydrated', max: 32},
            {description: 'Extreme caution: heat cramps possible', max: 39},
            {description: 'Danger: heatstroke likely, extreme caution', max: 46},
            {description: 'Extreme danger: heat stroke imminent', max: Infinity}
        ];

        this.windChillSummaries = [
            {description: "Minimal wind chill risk", "min": 0},
            {description: "Mild cold—light jacket", "min": -10},
            {description: "High frostbite risk—dress warm", "min": -28},
            {description: "Severe frostbite risk—limit exposure", "min": -40},
            {description: "Extreme risk—avoid outdoor exposure", "min": Number.NEGATIVE_INFINITY}
        ];
    }

    /**
     * Loads weather data for the specified launch location and optionally for the ground location.
     *
     * @param {string} launchLocation - The location for which to load launch weather data.
     * @param {?string} [groundLocation=null] - The optional location for which to load ground weather data.
     * @param launchCacheTimeoutSeconds - The cache timeout for the launch site
     * @param groundCacheTimeout - The cache timeout for the ground site (typically used for lapse rate calculations)
     * @return {Promise<Object>} An object containing weather data including observations, lapse rate information, UV index,
     * barometric pressure, and dew point. Returns null or undefined values for properties if no data is available.
     */
    async loadWeatherData(launchLocation, groundLocation = null, launchCacheTimeoutSeconds = 60, groundCacheTimeout = 60*30) {
        let lapseRateInfo, observation, uvIndex, barometricPressure, dewPoint, humidity, heatIndex, windChill;
        const launchWeather = await this.weatherUnderground.getWeather(launchLocation, launchCacheTimeoutSeconds); // 60-second cache

        if (groundLocation) {
            const lzWeather = await this.weatherUnderground.getWeather(groundLocation, groundCacheTimeout); // 30-minute cache
            lapseRateInfo = this.calculateLapseRate(launchWeather, lzWeather);
        }

        if (launchWeather && launchWeather.observations && launchWeather.observations.length > 0) {
            observation = launchWeather.observations[0];
            uvIndex = this.uvIndexSummaries.find(s => observation.uv <= s.max);
            let seaLevelPressure = this.computeSeaLevelPressure(observation.uk_hybrid.elev, observation.uk_hybrid.pressure);

            barometricPressure = {
                description: this.barometricPressureSummaries.find(s => seaLevelPressure <= s.max).description,
                kPa: (observation.uk_hybrid.pressure / 10).toFixed(1),
                hPa: observation.uk_hybrid.pressure.toFixed(1)
            };

            dewPoint = {
                description: this.dewPointSummaries.find(s => observation.uk_hybrid.dewpt <= s.max).description,
                celsius: observation.uk_hybrid.dewpt.toFixed(1)
            };

            humidity = {
                description: this.humiditySummaries.find(s => observation.humidity <= s.max).description,
                percent: observation.humidity.toFixed(0)
            };

            heatIndex = {
                description: this.heatIndexSummaries.find(s => observation.uk_hybrid.heatIndex <= s.max).description,
                celsius: observation.uk_hybrid.heatIndex.toFixed(1)
            }

            windChill = {
                description: this.windChillSummaries.find(s => observation.uk_hybrid.windChill >= s.min).description,
                celsius: observation.uk_hybrid.windChill.toFixed(1)
            }
        }
        return {
            observation,
            lapseRateInfo,
            uvIndex,
            barometricPressure,
            dewPoint,
            humidity,
            heatIndex,
            windChill
        }
    }

    /**
     * Converts wind direction in degrees to cardinal/intercardinal direction
     * @param {number} degrees - Wind direction in degrees (0-360)
     * @returns {string} Cardinal/intercardinal direction (N, NE, E, SE, S, SW, W, NW)
     */
    degreesToDirection(degrees) {
        // Ensure degrees is within 0-360 range
        degrees = ((degrees % 360) + 360) % 360;
        return this.directions.find(dir => dir.min <= degrees && degrees < dir.max).name;
    }

    /**
     * Calculates the temperature lapse rate between two locations
     * @param {Object} primaryData - Weather data from primary location
     * @param {Object} lapsData - Weather data from laps location
     * @returns {Object} Object containing lapse rate (°C/km) and elevation difference (m)
     */
    calculateLapseRate(primaryData, lapsData) {
        if (!primaryData?.observations?.[0] || !lapsData?.observations?.[0]) {
            return {lapseRate: null, elevDiff: null, summary: null};
        }

        const primaryObs = primaryData.observations[0];
        const lapsObs = lapsData.observations[0];
        const elevDiffFeet = lapsObs.uk_hybrid.elev - primaryObs.uk_hybrid.elev;
        const elevDiffThousandFeet = Math.abs(elevDiffFeet / 1000);
        const tempDiff = primaryObs.uk_hybrid.temp - lapsObs.uk_hybrid.temp;
        const lapseRate = elevDiffThousandFeet < 0.001 ? 0 : tempDiff / elevDiffThousandFeet;
        const lapseDetails = this.lapseSummaries.find(s => lapseRate <= s.max);

        return {
            lapseRate: lapseRate.toFixed(2),
            elevDiff: Math.abs(elevDiffFeet).toFixed(1),
            details: lapseDetails
        };
    }

    /**
     * Compute sea‐level equivalent pressure from station pressure and elevation.
     *
     * @param {number} elevationFeet - Elevation in feet above sea level.
     * @param {number} pressureHpa  - Measured pressure in hPa.
     * @returns {number} Sea‐level equivalent pressure in kPa.
     */
    computeSeaLevelPressure(elevationFeet, pressureHpa) {
        // Convert elevation to meters
        const elevationM = elevationFeet * 0.3048;

        // Standard constants
        const T0 = 288.15;       // Sea‐level standard temperature (K)
        const L = 0.0065;        // Temperature lapse rate (K/m)
        const g = 9.80665;       // Gravitational acceleration (m/s²)
        const R = 287.05;        // Specific gas constant for dry air (J/(kg·K))
        const exponent = g / (R * L);

        // Barometric formula factor
        const factor = Math.pow(
            1 - (L * elevationM) / T0,
            -exponent
        );

        return (pressureHpa * factor) / 10;
    }
}

// Initialize the weather instance
app.weather = new Weather();
