/**
 * A repeating read that never doubles up.
 *
 * Both pages keep re-reading their stations for as long as they are open, and
 * both have to queue the next read from three places: after a good load, after
 * a failed one, and when the reader comes back to the tab. Each of those has to
 * cancel whatever was already pending or the page ends up with two timers and
 * fetches twice as often as it was asked to, forever.
 */

export class Loop {
    /**
     * @param {function(): void} task - What to run each time
     */
    constructor(task) {
        this.task = task;
        this.timer = null;
    }

    /**
     * Runs the task once, after a delay, replacing any pending run.
     * @param {number} ms - Milliseconds to wait
     * @returns {void}
     */
    in(ms) {
        this.cancel();
        this.timer = setTimeout(() => this.task(), ms);
    }

    /**
     * Drops the pending run, if there is one.
     * @returns {void}
     */
    cancel() {
        clearTimeout(this.timer);
        this.timer = null;
    }
}
