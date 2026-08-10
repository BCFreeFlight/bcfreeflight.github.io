/**
 * Runs the test page in headless Chrome and reports what it found.
 *
 * Chrome's own `--dump-dom` prints the page at the load event, which is before
 * any of these tests have run, so the browser is driven over the DevTools
 * protocol instead: wait for `window.__tests`, read the totals, print the
 * failures, exit with the truth. Node has both `fetch` and `WebSocket` built
 * in, so this still installs nothing.
 *
 * Not usually run directly — `tests/run.sh` starts the server and calls it.
 */

import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const url = process.argv[2];
const chrome = process.argv[3];
const deadline = Number(process.env.TEST_TIMEOUT_MS ?? 60000);

if (!url || !chrome) {
    console.error('usage: headless.mjs <url> <chrome>');
    process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'bcff-tests-'));

// Port 0 asks the operating system for a free one, which Chrome then writes to
// DevToolsActivePort in the profile. Picking a number ourselves would sooner or
// later pick one something else is already on.
const browser = spawn(chrome, [
    '--headless',
    '--disable-gpu',
    // Both of these are for containers: a build agent has no sandbox to speak
    // of and a small /dev/shm that Chrome will otherwise run out of.
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    url
], {stdio: ['ignore', 'ignore', 'pipe']});

// Kept so that a browser which dies on startup can say why, instead of leaving
// us to report only that it never answered.
let complaints = '';
browser.stderr.on('data', chunk => {
    complaints += chunk;
});

let exited = null;
browser.on('exit', code => {
    exited = code;
});

/**
 * @param {number} ms - How long to wait
 * @returns {Promise<void>}
 */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Cleans up whatever is still running and ends the process.
 * @param {number} code - Exit status
 * @returns {void}
 */
function finish(code) {
    browser.kill();
    try {
        rmSync(profile, {recursive: true, force: true});
    } catch (error) {
        // A profile directory that will not delete is not worth failing over.
    }
    process.exit(code);
}

/**
 * The port Chrome chose, once it has written one down.
 * @returns {number|null} The port, or null if it has not said yet
 */
function chosenPort() {
    try {
        const [line] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
        const port = Number(line);
        return port > 0 ? port : null;
    } catch (error) {
        // Chrome has not got that far yet.
        return null;
    }
}

/**
 * The page target, once Chrome is listening.
 *
 * A cold build agent can take a good while to get a browser up — the runner
 * image spends seconds on `--version` alone — so this waits out the same
 * deadline as the tests themselves rather than a shorter one of its own.
 *
 * @returns {Promise<Object>} The target description
 */
async function target() {
    const until = Date.now() + deadline;

    while (Date.now() < until) {
        if (exited !== null) {
            throw new Error(`Chrome exited with ${exited} before listening.${complaints ? `\n${complaints.trim()}` : ''}`);
        }

        const port = chosenPort();
        if (port) {
            try {
                const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
                const page = targets.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl);
                if (page) return page;
            } catch (error) {
                // Listening, but not ready to describe its tabs yet.
            }
        }

        await wait(100);
    }

    throw new Error(`Chrome never started listening within ${deadline}ms.${complaints ? `\n${complaints.trim()}` : ''}`);
}

let page;
try {
    page = await target();
} catch (error) {
    console.error(String(error.message));
    finish(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);

await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', () => reject(new Error('Could not attach to Chrome')), {once: true});
});

let nextId = 0;
const pending = new Map();

socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (!settle) return;

    pending.delete(message.id);
    settle(message);
});

/**
 * Evaluates an expression in the page.
 * @param {string} expression - JavaScript to run
 * @returns {Promise<*>} Whatever it evaluated to
 */
function evaluate(expression) {
    const id = ++nextId;

    return new Promise((resolve, reject) => {
        pending.set(id, message => {
            if (message.error) return reject(new Error(message.error.message));
            if (message.result?.exceptionDetails) {
                return reject(new Error(message.result.exceptionDetails.text));
            }
            resolve(message.result?.result?.value);
        });

        socket.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {expression, returnByValue: true, awaitPromise: true}
        }));
    });
}

const started = Date.now();
let totals = null;

while (Date.now() - started < deadline) {
    try {
        totals = await evaluate('window.__tests ? JSON.stringify(window.__tests) : null');
    } catch (error) {
        // The page may still be loading its modules.
    }

    if (totals) break;
    await wait(200);
}

if (!totals) {
    console.error(`No results after ${deadline}ms. Open ${url} in a browser to see why.`);
    finish(1);
}

const {passed, failed, failures} = JSON.parse(totals);

failures.forEach(failure => {
    console.log(`FAILED ${failure.suite} — ${failure.test}`);
    console.log(String(failure.error).split('\n').map(line => `        ${line}`).join('\n'));
});

console.log(`TESTS ${failed === 0 ? 'PASS' : 'FAIL'} ${passed}/${passed + failed}`);

finish(failed === 0 ? 0 : 1);
