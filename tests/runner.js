/**
 * A test runner, in a browser, with nothing to install.
 *
 * The site has no build step and no package manifest, and adding one to get a
 * test runner would cost more than the tests are worth. So the tests run where
 * the code runs: real modules, a real DOM, a real fetch. `tests/run.sh` drives
 * the same page headlessly for anyone who would rather see a exit code than a
 * web page.
 */

const suites = [];
let current = null;

/**
 * Nothing here talks to the internet.
 *
 * Tests that reach a live API are slow, flaky, and quietly wrong the day the
 * weather changes — and this API is rate-limited on a key shared with every
 * visitor to the site. So anything that is not a local file is refused outright
 * rather than left to chance: a test that starts calling out fails immediately,
 * naming the URL it tried.
 */
const realFetch = window.fetch.bind(window);

window.fetch = (resource, options) => {
    const url = new URL(typeof resource === 'string' ? resource : resource.url, window.location.href);

    if (url.origin !== window.location.origin) {
        return Promise.reject(new Error(
            `Tests must not call out: ${url.href}. Stub fetch, or add a fixture.`));
    }

    return realFetch(resource, options);
};

/**
 * Runs a body with fetch replaced, then puts the real one back.
 *
 * How every API failure below is staged: a station that 404s, one that answers
 * with something that is not JSON, one that has nothing logged yet.
 *
 * @param {function(string): (Promise<Response>|Response)} stub - Stands in for fetch
 * @param {function(): (void|Promise<void>)} body - The test
 * @returns {Promise<void>}
 */
export async function withFetch(stub, body) {
    const previous = window.fetch;
    const calls = [];

    window.fetch = (resource, options) => {
        const url = typeof resource === 'string' ? resource : resource.url;
        calls.push(url);
        return Promise.resolve(stub(url, options));
    };

    try {
        await body(calls);
    } finally {
        window.fetch = previous;
    }
}

/**
 * A stand-in API response.
 * @param {Object} [options] - status, body and whether the body is valid JSON
 * @returns {Response} Something fetch could plausibly have returned
 */
export function response({status = 200, body = {}, raw = null} = {}) {
    // A 204 is defined as having no body at all, and Response refuses to be
    // constructed with one — which is exactly the case the station hits when it
    // has nothing logged yet.
    const content = status === 204 || status === 304 ? null : (raw ?? JSON.stringify(body));

    return new Response(content, {
        status,
        headers: {'Content-Type': 'application/json'}
    });
}

/**
 * Groups related checks under a heading.
 * @param {string} name - What is being tested
 * @param {function(): void} body - Registers the checks
 * @returns {void}
 */
export function describe(name, body) {
    current = {name, tests: []};
    suites.push(current);
    body();
    current = null;
}

/**
 * One check. May be async.
 * @param {string} name - What should be true
 * @param {function(): (void|Promise<void>)} body - Throws to fail
 * @returns {void}
 */
export function it(name, body) {
    if (!current) throw new Error(`"${name}" is outside a describe block`);
    current.tests.push({name, body});
}

/**
 * A stable string for a value, so two objects that differ only in key order
 * still compare equal — the tests care about content, not about the order a
 * literal happened to be written in.
 * @param {*} value - Anything
 * @returns {string} Its canonical form
 */
function canonical(value) {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/**
 * Fails unless the two values match, structurally.
 * @param {*} actual - What happened
 * @param {*} expected - What should have happened
 * @param {string} [message] - Added to the failure
 * @returns {void}
 */
export function equal(actual, expected, message = '') {
    const a = canonical(actual);
    const b = canonical(expected);

    if (a !== b) {
        throw new Error(`${message ? message + '\n' : ''}  expected: ${b}\n  actual:   ${a}`);
    }
}

/**
 * Fails unless the value is truthy.
 * @param {*} value - What happened
 * @param {string} [message] - Added to the failure
 * @returns {void}
 */
export function ok(value, message = 'expected a truthy value') {
    if (!value) throw new Error(`${message}\n  actual: ${canonical(value)}`);
}

/**
 * Fails unless the body throws.
 * @param {function(): void} body - The call that should fail
 * @param {string} [message] - Added to the failure
 * @returns {void}
 */
export function throws(body, message = 'expected this to throw') {
    try {
        body();
    } catch (error) {
        return;
    }

    throw new Error(message);
}

/**
 * A number, near enough. Floating point arithmetic on temperatures does not
 * come out to the last bit, and the tests should not pretend otherwise.
 * @param {number} actual - What happened
 * @param {number} expected - What should have happened
 * @param {number} [tolerance=1e-9] - How far apart they may be
 * @returns {void}
 */
export function close(actual, expected, tolerance = 1e-9) {
    if (!(Math.abs(actual - expected) <= tolerance)) {
        throw new Error(`  expected: ${expected} (±${tolerance})\n  actual:   ${actual}`);
    }
}

/**
 * Runs everything registered, reports it on the page, and leaves the totals on
 * `window.__tests` for whatever is driving the browser.
 * @returns {Promise<Object>} passed, failed and the failures
 */
export async function run() {
    const failures = [];
    let passed = 0;

    const output = document.getElementById('output');
    output.innerHTML = '';

    for (const suite of suites) {
        const block = document.createElement('section');
        block.innerHTML = `<h2>${suite.name}</h2>`;
        output.appendChild(block);

        for (const test of suite.tests) {
            const line = document.createElement('div');

            try {
                await test.body();
                passed += 1;
                line.className = 'pass';
                line.textContent = `ok   ${test.name}`;
            } catch (error) {
                failures.push({suite: suite.name, test: test.name, error: error.message});
                line.className = 'fail';
                line.innerHTML = `<strong>FAIL ${test.name}</strong><pre>${
                    String(error.message).replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c])
                }</pre>`;
            }

            block.appendChild(line);
        }
    }

    const summary = document.getElementById('summary');
    summary.className = failures.length ? 'fail' : 'pass';
    summary.textContent = failures.length
        ? `${passed} passed, ${failures.length} FAILED`
        : `${passed} passed`;

    const totals = {passed, failed: failures.length, failures};
    window.__tests = totals;

    // What run.sh greps for.
    console.log(`TESTS ${failures.length === 0 ? 'PASS' : 'FAIL'} ${passed}/${passed + failures.length}`);
    failures.forEach(f => console.log(`FAILED ${f.suite} — ${f.test}: ${f.error}`));

    return totals;
}

/**
 * Loads a captured API response.
 * @param {string} name - The fixture's file name, without extension
 * @returns {Promise<Object>} The parsed fixture
 */
export async function fixture(name) {
    const response = await fetch(new URL(`./fixtures/${name}.json`, import.meta.url));
    if (!response.ok) throw new Error(`Missing fixture ${name}`);
    return response.json();
}
