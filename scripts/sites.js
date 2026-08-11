import {launchWindow} from './lib/launch.js';
import {
    DEFAULT_CACHE_SECONDS,
    MINIMUM_REFRESH_SECONDS,
    REFERENCE_CACHE_SECONDS
} from './config/defaults.js';

/**
 * Site configuration.
 *
 * Every site and its stations are described in sites/sites.json. Nothing else
 * in the app names a station, so adding a site or moving a station is a change
 * to that file alone.
 */

const CONFIG_URL = new URL('../sites/sites.json', import.meta.url);

export class Sites {
    constructor() {
        // One fetch per page load, shared by everything that asks.
        this.pending = null;
    }

    /**
     * Loads the site configuration, reusing the in-flight or completed request.
     * @returns {Promise<Object>} The parsed configuration
     */
    async load() {
        if (!this.pending) {
            this.pending = fetch(CONFIG_URL)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`Site configuration returned ${response.status}`);
                    }
                    return response.json();
                })
                .catch(error => {
                    // Let the next caller try again rather than caching a failure.
                    this.pending = null;
                    throw error;
                });
        }

        return this.pending;
    }

    /**
     * Resolves one site by its slug, with each station normalised.
     * @param {string} slug - The site key, e.g. "coopers"
     * @returns {Promise<Object>} slug, name and stations
     */
    async site(slug) {
        const config = await this.load();
        const site = config?.sites?.[slug];

        if (!site) {
            throw new Error(`No site named "${slug}" in the site configuration`);
        }

        return {
            slug,
            name: site.name ?? slug,
            stations: (site.stations ?? []).map((station, index) => this.station(station, index))
        };
    }

    /**
     * Every configured site, in the order the configuration lists them.
     *
     * The home page is built from this, so adding a site to sites.json puts it
     * on the front page without anyone editing the markup.
     *
     * @returns {Promise<Object[]>} Resolved sites
     */
    async all() {
        const config = await this.load();
        const slugs = Object.keys(config?.sites ?? {});

        return Promise.all(slugs.map(slug => this.site(slug)));
    }

    /**
     * Fills in the parts a station may leave out.
     * @param {Object} station - A station entry from the configuration
     * @param {number} index - Its position in the site's list
     * @returns {Object} key, name, id, isDefault, launch and cacheSeconds
     */
    station(station, index) {
        const isDefault = station.default === true;

        return {
            youtube: this.youtube(station.youtube),
            // Only a station standing at a launch has one, and most do not: the
            // valley and the summit stations report the same site's weather
            // without being anywhere anyone takes off from.
            launch: launchWindow(station.launch),
            coordinates: this.coordinates(station.coordinates),
            // Stable enough to use in element ids and to key state by.
            key: station.wunderground.toLowerCase(),
            name: station.name ?? station.wunderground,
            // For places where the full name would crowd the line, such as a
            // lapse segment naming two stations at once.
            shortName: station.short_name ?? station.name ?? station.wunderground,
            id: station.wunderground,
            isDefault,
            order: index,
            cacheSeconds: station.cacheSeconds
                ?? (isDefault ? DEFAULT_CACHE_SECONDS : REFERENCE_CACHE_SECONDS)
        };
    }

    /**
     * Where a station stands, as stated by the configuration.
     *
     * Every station reports its own position in its observation, and for
     * anything measured that is the honest source — an instrument's readings
     * belong to wherever the instrument is. This is for the one thing that is
     * not a measurement: the satellite tile behind the wind direction, which
     * should be centred on the place people know by name. A station is sited
     * where it can be serviced and where it reads the air cleanly, which at
     * Cooper's is tens of metres off the takeoff itself.
     *
     * Both or neither. Half a coordinate is no place at all, and centring a map
     * on it would put a station somewhere it has never been.
     *
     * @param {?Object} coordinates - The configured latitude and longitude
     * @returns {?Object} latitude and longitude, or null when unstated
     */
    coordinates(coordinates) {
        const {latitude, longitude, elevation} = coordinates ?? {};

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

        // Elevation is optional and separate from the both-or-neither rule the
        // pair above follows: a station can be placed without its height being
        // known. Where it *is* known it is the site's own figure and it beats
        // the one Weather Underground carries, which is whatever the station's
        // owner typed into a form.
        return {latitude, longitude, elevation: Number.isFinite(elevation) ? elevation : null};
    }

    /**
     * Normalises a station's YouTube source.
     *
     * A bare string is taken as a video id. A channel is worth stating as well,
     * because `live_stream?channel=` follows whatever that channel is
     * broadcasting now, where a video id names one broadcast and goes stale the
     * next time the stream restarts.
     *
     * @param {?(string|Object)} youtube - The configured value, if any
     * @returns {?Object} {channel, video}, or null when nothing is configured
     */
    youtube(youtube) {
        if (!youtube) return null;

        if (typeof youtube === 'string') {
            return {channel: null, video: youtube};
        }

        return {
            channel: youtube.channel ?? null,
            video: youtube.video ?? null
        };
    }

    /**
     * The first station of a site that carries a camera.
     * @param {Object[]} stations - Normalised stations
     * @returns {?Object} The station, or null when the site has no camera
     */
    withCamera(stations) {
        return stations.find(station => station.youtube) ?? null;
    }

    /**
     * Reading order for the tabs: the default station leads, the rest follow in
     * the order the configuration lists them.
     * @param {Object[]} stations - Normalised stations
     * @returns {Object[]} A new, ordered array
     */
    inTabOrder(stations) {
        return [...stations].sort((a, b) =>
            (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || a.order - b.order);
    }

    /**
     * How often to re-read a site, in milliseconds.
     *
     * This is the shortest cache timeout among its stations. Polling at that
     * cadence lets every station come back exactly as often as its own timeout
     * allows: the frequent one refetches each time, and the slower ones are
     * served from cache until their own timeout lapses. So one timer honours
     * every station's setting without a timer each.
     *
     * @param {Object[]} stations - Normalised stations
     * @returns {number} Milliseconds between refreshes
     */
    refreshMs(stations) {
        const seconds = stations
            .map(station => station.cacheSeconds)
            .filter(value => Number.isFinite(value) && value > 0);

        if (!seconds.length) return REFERENCE_CACHE_SECONDS * 1000;

        // A floor, so a station configured at a few seconds cannot turn the
        // page into a polling loop.
        return Math.max(Math.min(...seconds), MINIMUM_REFRESH_SECONDS) * 1000;
    }

    /**
     * The site a page belongs to, taken from `data-site` on the body.
     * @returns {?string} The slug, or null when the page does not declare one
     */
    slugFromPage() {
        return document.body.dataset.site ?? null;
    }
}

const sites = new Sites();
export default sites;
