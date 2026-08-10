/**
 * Remembering things between visits.
 *
 * Everything the site stores is a convenience: which measurements were being
 * charted, whether the video was cropped, a station's readings so the next page
 * does not refetch them. None of it is worth an exception, and a browser in
 * private mode or with a full quota throws on the simplest write. So every path
 * through here tolerates failure and the caller carries on with its fallback.
 */

/**
 * A stored string.
 * @param {string} key - Storage key
 * @param {*} [fallback=null] - Returned when nothing is stored, or storage is unreadable
 * @returns {string|*} The stored value, or the fallback
 */
export function readText(key, fallback = null) {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch (error) {
        return fallback;
    }
}

/**
 * Stores a string.
 * @param {string} key - Storage key
 * @param {string} value - Value to store
 * @returns {boolean} Whether it was stored
 */
export function writeText(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * A stored value, parsed. Unparseable content is treated as absent rather than
 * thrown, so one bad entry cannot keep a page from loading.
 * @param {string} key - Storage key
 * @param {*} [fallback=null] - Returned when nothing usable is stored
 * @returns {*} The stored value, or the fallback
 */
export function readJson(key, fallback = null) {
    try {
        const stored = localStorage.getItem(key);
        return stored === null ? fallback : JSON.parse(stored);
    } catch (error) {
        return fallback;
    }
}

/**
 * Stores a value as JSON.
 * @param {string} key - Storage key
 * @param {*} value - Value to store
 * @returns {boolean} Whether it was stored, so a caller that cares can say so
 */
export function writeJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        return false;
    }
}
