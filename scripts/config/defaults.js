/**
 * How often things happen, and how long they are kept.
 *
 * These were spread across five files, which made the site's real polling
 * behaviour impossible to see: two pages each declared their own retry delay,
 * the chart's cache lived beside the fetch that used it, and the player's
 * settings sat in the middle of the live page's controller. Gathered here, the
 * whole cadence of the site can be read — and changed — in one place.
 *
 * Per-station timings still belong in sites.json. These are the fallbacks and
 * the timings that are not a property of any one station.
 */

/**
 * How long a station's reading is good for when it does not say. The station
 * being watched stays fresh; the ones that only feed lapse rate are cheap to
 * hold on to.
 */
export const DEFAULT_CACHE_SECONDS = 60;
export const REFERENCE_CACHE_SECONDS = 60 * 30;

// A floor under the refresh cadence, so a station configured at a few seconds
// cannot turn the page into a polling loop.
export const MINIMUM_REFRESH_SECONDS = 30;

// How long to wait before trying again when a read fails outright. Short,
// because a failed read leaves the page with nothing to show.
export const RETRY_MS = 60 * 1000;

// The day's buckets arrive every five minutes, so asking more often than that
// only re-reads the same day. A floor under each station's own cache timeout,
// and the default for a caller that does not name one.
export const HISTORY_CACHE_SECONDS = 5 * 60;

// How long a tile takes to move to a new value: a number counting to it, an
// arrow turning to it. Long enough to be caught out of the corner of an eye on
// a screen at a launch, short enough to be over well before the next read.
export const TILE_TRANSITION_MS = 2000;

// When a station counts as having stopped rather than as being between
// readings. Four missed buckets: one late bucket is ordinary, twenty minutes of
// silence is not. Until the readings moved onto the day there was no staleness
// check at all — a station that went dark in the night kept its last reading on
// the page all morning, correctly timestamped and entirely believed.
export const OBSERVATION_STALE_SECONDS = 20 * 60;

// Air quality is published hourly and moves slowly, so it is held far longer
// than a station reading. Half an hour keeps a page that refreshes every minute
// from asking sixty times for the same number.
export const AIR_CACHE_SECONDS = 30 * 60;

// The modelled air above the stations, on the same reasoning and the same
// hourly cadence.
export const SOUNDING_CACHE_SECONDS = 30 * 60;

// The forecast, which changes less often than either. HRDPS runs four times a
// day and takes a couple of hours to publish, so most of a half-hour window
// returns numbers that have not moved at all — and unlike the readings, a
// forecast that is thirty minutes old is not stale in any sense a pilot cares
// about.
export const FORECAST_CACHE_SECONDS = 30 * 60;

// Checking the camera costs a hidden player, so it lags well behind the
// readings rather than running with them.
export const CAMERA_CHECK_MS = 5 * 60 * 1000;

// The probe reports within about half a second; this is only a backstop.
export const LIVE_PROBE_TIMEOUT_MS = 12000;

// A stream left running drifts and eventually stalls, so the player is
// reloaded hourly...
export const STREAM_RELOAD_MS = 60 * 60 * 1000;

// ...and the whole page is reloaded twice a day, which also picks up any
// deployed change on a screen nobody ever navigates.
export const PAGE_RELOAD_MS = 8 * 60 * 60 * 1000;

/**
 * The player settings the live page has always used: muted autoplay, no chrome.
 * @type {Object}
 */
export const PLAYER_PARAMS = {
    autoplay: 1,
    mute: 1,
    controls: 0,
    rel: 0,
    showinfo: 0,
    loop: 1,
    modestbranding: 1,
    iv_load_policy: 3,
    disablekb: 1
};

/**
 * Where preferences and cached readings are kept. Named here so a key is never
 * spelled differently in two places — a typo would silently lose a reader's
 * saved settings rather than fail.
 * @type {Object}
 */
export const STORAGE_KEYS = {
    day: id => `weather_history_${id}`,
    // Keyed by place rather than by station, because the air does not belong to
    // any one of them: two stations on the same hillside read the same square.
    air: (latitude, longitude) => `air_quality_${latitude}_${longitude}`,
    sounding: (latitude, longitude) => `sounding_${latitude}_${longitude}`,
    // Not rounded onto a grid the way the other two are. The forecast carries
    // the terrain height of the point it was asked about, and around Cooper's a
    // tenth of a degree is a few hundred metres of hillside.
    forecast: (latitude, longitude) => `forecast_${latitude}_${longitude}`,
    liveView: 'live_view_mode',
    liveWeather: 'live_weather_visible',
    trendSeries: 'trend_series',
    trendMode: 'trend_mode',
    windgramDay: 'windgram_day',
    // Per site, because which station a reader watches is a property of the
    // hill they fly, not of the browser.
    station: slug => `station_${slug}`
};
