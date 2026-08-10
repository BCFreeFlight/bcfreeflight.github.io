import api from './wu-api.js';
import * as bands from './config/bands.js';
import {pointAt} from './config/compass.js';
import {STORAGE_KEYS} from './config/defaults.js';
import {readJson, writeJson} from './lib/storage.js';
import {band, isNumber} from './lib/numbers.js';
import {lapseRate} from './lib/lapse.js';

/**
 * Reading the stations, and saying what the readings mean.
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
 * A station's current reading, held for as long as it is worth holding.
 *
 * The cache is aged off the observation's own timestamp rather than off when it
 * was fetched, so a station that has stopped updating is recognised as stale
 * instead of looking fresh every time it is re-read.
 */
export class WeatherUnderground {
    /**
     * Retrieves weather data for the specified location, with optional caching support.
     *
     * @param {string} location - The location identifier for which to fetch the weather data.
     * @param {number} [cacheTimeoutSeconds=0] - The time in seconds the data should be considered valid in the cache. Defaults to 0, which disables caching.
     * @return {Promise<?Object>} A promise resolving to the weather data, or null.
     */
    async getWeather(location, cacheTimeoutSeconds = 0) {
        const cacheKey = STORAGE_KEYS.observation(location);
        const cached = readJson(cacheKey);
        const observedAt = cached?.data?.observations?.[0]?.obsTimeUtc;

        if (observedAt && cacheTimeoutSeconds > 0) {
            const ageInSeconds = (Date.now() - Date.parse(observedAt)) / 1000;

            if (ageInSeconds < cacheTimeoutSeconds) {
                console.log(`Using cached weather data for ${location} (age: ${Math.round(ageInSeconds)}s, timeout: ${cacheTimeoutSeconds}s)`);
                return cached.data;
            }
        }

        const data = await this.fetchWeatherData(location);

        if (data) writeJson(cacheKey, {data});

        return data;
    }

    /**
     * Reads a station, reporting a failure as no data rather than as an error:
     * the page has a cached reading to fall back on and a placeholder to show.
     * @param {string} location - The station identifier
     * @return {Promise<?Object>} The weather data, or null
     */
    async fetchWeatherData(location) {
        try {
            return await api.current(location);
        } catch (error) {
            console.error("Error fetching weather data:", error);
            return null;
        }
    }
}

/**
 * Main Weather class for handling weather data and calculations
 */
export class Weather {
    constructor() {
        this.weatherUnderground = new WeatherUnderground();
    }

    /**
     * Loads every station of a site.
     *
     * Stations are fetched and interpreted independently, each with its own
     * cache timeout, so one going dark never takes the others down with it.
     * Each station keeps its configuration alongside its reading, which is what
     * lets the pages stay free of hardcoded station ids.
     *
     * @param {Object[]} stations - Normalised stations from the site configuration
     * @return {Promise<Object[]>} One entry per station: station, observation, metrics, online
     */
    async loadStations(stations) {
        return Promise.all(stations.map(async station => {
            const data = await this.safeGetWeather(station.id, station.cacheSeconds);
            const observation = this.firstObservation(data);

            return {
                station,
                observation,
                metrics: this.describeObservation(observation),
                online: Boolean(observation)
            };
        }));
    }

    /**
     * Fetches a station, resolving to null instead of rejecting so that one
     * failing station cannot reject the whole page load
     * @param {string} location - The station identifier
     * @param {number} cacheTimeoutSeconds - Cache timeout for this station
     * @returns {Promise<?Object>} The station data, or null
     */
    async safeGetWeather(location, cacheTimeoutSeconds) {
        try {
            return await this.weatherUnderground.getWeather(location, cacheTimeoutSeconds);
        } catch (error) {
            console.error(`Station ${location} failed to load:`, error);
            return null;
        }
    }

    /**
     * Pulls the current observation out of an API response, if there is one
     * @param {?Object} stationData - Raw Weather Underground response
     * @returns {?Object} The observation, or undefined when the station is dark
     */
    firstObservation(stationData) {
        return stationData?.observations?.[0];
    }

    /**
     * Derives the interpreted metrics for a single observation. Each metric is
     * independent: a missing reading yields nulls for that metric alone.
     * @param {?Object} observation - A single station observation
     * @returns {Object} uvIndex, barometricPressure, dewPoint, humidity, heatIndex, windChill
     */
    describeObservation(observation) {
        const empty = {
            uvIndex: null,
            barometricPressure: null,
            dewPoint: null,
            humidity: null,
            heatIndex: null,
            windChill: null
        };

        if (!observation) {
            return empty;
        }

        const uk = observation.uk_hybrid ?? {};

        const seaLevelPressure = isNumber(uk.pressure)
            ? this.computeSeaLevelPressure(uk.elev, uk.pressure)
            : null;

        return {
            uvIndex: isNumber(observation.uv) ? band(bands.UV, observation.uv) : null,

            barometricPressure: isNumber(uk.pressure) ? {
                description: band(bands.PRESSURE, seaLevelPressure).description,
                kPa: (uk.pressure / 10).toFixed(1),
                hPa: uk.pressure.toFixed(1)
            } : null,

            dewPoint: isNumber(uk.dewpt) ? {
                description: band(bands.DEW_POINT, uk.dewpt).description,
                celsius: uk.dewpt.toFixed(1)
            } : null,

            humidity: isNumber(observation.humidity) ? {
                description: band(bands.HUMIDITY, observation.humidity).description,
                percent: observation.humidity.toFixed(0)
            } : null,

            heatIndex: isNumber(uk.heatIndex) ? {
                description: band(bands.HEAT_INDEX, uk.heatIndex).description,
                celsius: uk.heatIndex.toFixed(1)
            } : null,

            windChill: isNumber(uk.windChill) ? {
                description: band(bands.WIND_CHILL, uk.windChill).description,
                celsius: uk.windChill.toFixed(1)
            } : null
        };
    }

    /**
     * Converts wind direction in degrees to cardinal/intercardinal direction
     * @param {number} degrees - Wind direction in degrees (0-360)
     * @returns {string} Cardinal/intercardinal direction (N, NNE, NE, ...)
     */
    degreesToDirection(degrees) {
        return pointAt(degrees).abbr;
    }

    /**
     * Calculates the temperature lapse rate between two observations.
     *
     * Which one is higher is decided by their reported elevation rather than by
     * the order they arrive in, so callers can hand over any pair.
     *
     * @param {?Object} a - One station's observation
     * @param {?Object} b - The other station's observation
     * @returns {Object} lapseRate, elevDiff and the matching stability band
     */
    calculateLapseRate(a, b) {
        // Needs both stations. Keep the shape stable so callers can render a
        // placeholder without null-checking every nested field.
        if (!a?.uk_hybrid || !b?.uk_hybrid) {
            return {lapseRate: null, elevDiff: null, details: null};
        }

        const [upper, lower] = a.uk_hybrid.elev >= b.uk_hybrid.elev ? [a, b] : [b, a];
        const elevDiffFeet = upper.uk_hybrid.elev - lower.uk_hybrid.elev;
        const rate = lapseRate(lower.uk_hybrid.temp, upper.uk_hybrid.temp, elevDiffFeet / 1000);

        return {
            lapseRate: rate.toFixed(2),
            elevDiff: Math.abs(elevDiffFeet).toFixed(1),
            details: band(bands.LAPSE, rate)
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

// Export a default instance of the Weather class
const weather = new Weather();
export default weather;
