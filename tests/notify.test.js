import system from 'system';

import {decide, parseState, serializeState, Urgency, STATE_VERSION, CREDIT_WARNING_MS} from '../lib/notify.js';
import {format as formatCountdown, localDateHm} from '../lib/countdown.js';
import {localTimeHm} from '../lib/format.js';
import {describe, it, assertEqual, assertDeepEqual, summary} from './_assert.js';

const NOW = new Date('2026-06-08T12:00:00.000Z');
const R1 = new Date('2026-06-08T17:00:00.000Z');
const R2 = new Date('2026-06-08T22:00:00.000Z');
const HOUR = 3600 * 1000;

const row = (percent, resetsAt = R1, key = 'session', label = 'Session') => ({key, label, percent, resetsAt});

function run(rows, previous = null, extra = {}) {
    return decide({vendor: 'Claude', rows, credits: [], threshold: 97, previous, now: NOW, ...extra});
}

// Feeds each percentage through decide in turn, carrying the state, and
// returns how many notifications each step fired.
function sequence(steps) {
    let state = null;
    return steps.map(step => {
        const r = run([typeof step === 'number' ? row(step) : step], state);
        state = r.state;
        return r.fired.length;
    });
}

describe('decide — threshold', () => {
    it('fires at exactly the threshold, normal urgency', () => {
        const {fired} = run([row(97)]);
        assertEqual(fired.length, 1);
        assertEqual(fired[0].urgency, Urgency.NORMAL);
    });

    it('below the threshold fires nothing', () => {
        assertEqual(run([row(96)]).fired.length, 0);
    });

    it('100% and above is critical', () => {
        assertEqual(run([row(100)]).fired[0].urgency, Urgency.CRITICAL);
    });

    it('the same crossing never fires twice', () => {
        assertDeepEqual(sequence([97, 98, 100]), [1, 0, 0]);
    });

    it('97 → 96 → 97 does not re-fire (inside the hysteresis band)', () => {
        assertDeepEqual(sequence([97, 96, 97]), [1, 0, 0]);
    });

    it('97 → 90 → 97 does not re-fire (90 is exactly threshold - 7)', () => {
        assertDeepEqual(sequence([97, 90, 97]), [1, 0, 0]);
    });

    it('97 → 89 → 97 re-fires', () => {
        assertDeepEqual(sequence([97, 89, 97]), [1, 0, 1]);
    });

    it('a later reset re-arms while still above the threshold', () => {
        assertDeepEqual(sequence([row(97, R1), row(98, R1), row(98, R2)]), [1, 0, 1]);
    });

    it('an earlier reset does not re-arm', () => {
        assertDeepEqual(sequence([row(97, R2), row(98, R1)]), [1, 0]);
    });

    it('a reset appearing where none was reported re-arms', () => {
        assertDeepEqual(sequence([row(97, null), row(97, null), row(97, R1)]), [1, 0, 1]);
    });

    it('a reset disappearing does not re-arm', () => {
        assertDeepEqual(sequence([row(97, R1), row(97, null)]), [1, 0]);
    });

    it('each window is keyed separately', () => {
        const {fired, state} = run([row(97), row(99, R2, 'weekly', 'Weekly')]);
        assertEqual(fired.length, 2);
        assertDeepEqual(Object.keys(state.entries).sort(), ['Claude::session', 'Claude::weekly']);
    });

    it('does not mutate the previous state', () => {
        const previous = run([row(97)]).state;
        const before = serializeState(previous);
        run([row(50)], previous);
        assertEqual(serializeState(previous), before);
    });
});

describe('decide — text', () => {
    it('title and body name the window, the body adds the reset', () => {
        const [n] = run([row(97)]).fired;
        assertEqual(n.title, 'Claude — Session at 97%');
        assertEqual(n.body, `97% of the Session used · resets ${formatCountdown(R1, NOW)} (${localTimeHm(R1)})`);
    });

    it('without a reset the body stops after the usage', () => {
        assertEqual(run([row(97, null)]).fired[0].body, '97% of the Session used');
    });

    it('goes through the injected translator', () => {
        const [n] = run([row(97, null)], null, {_: s => `<${s}>`}).fired;
        assertEqual(n.title, '<Claude — Session at 97%>');
    });
});

describe('decide — reset credits', () => {
    const credit = (offsetMs, title = 'Full reset') => ({title, expiresAt: new Date(NOW.getTime() + offsetMs)});
    const runCredits = (credits, previous = null) =>
        decide({vendor: 'OpenAI', rows: [], credits, threshold: 97, previous, now: NOW});

    it('a credit expiring in 47 h fires once', () => {
        const first = runCredits([credit(47 * HOUR)]);
        assertEqual(first.fired.length, 1);
        assertEqual(first.fired[0].urgency, Urgency.NORMAL);
        assertEqual(runCredits([credit(47 * HOUR)], first.state).fired.length, 0);
    });

    it('exactly 48 h fires; 49 h does not', () => {
        assertEqual(runCredits([credit(CREDIT_WARNING_MS)]).fired.length, 1);
        assertEqual(runCredits([credit(49 * HOUR)]).fired.length, 0);
    });

    it('an expired credit does not fire', () => {
        assertEqual(runCredits([credit(-1000)]).fired.length, 0);
        assertEqual(runCredits([credit(0)]).fired.length, 0);
    });

    it('a credit without an expiry does not fire', () => {
        assertEqual(runCredits([{title: 'x', expiresAt: null}]).fired.length, 0);
    });

    it('two credits with one expiry fire once', () => {
        assertEqual(runCredits([credit(10 * HOUR), credit(10 * HOUR, 'Other')]).fired.length, 1);
    });

    it('the key is the expiry instant', () => {
        const c = credit(10 * HOUR);
        assertDeepEqual(Object.keys(runCredits([c]).state.entries), [`OpenAI::credit::${c.expiresAt.toISOString()}`]);
    });

    it('title and body name the expiry; an untitled credit reads Reset credit', () => {
        const c = credit(10 * HOUR, null);
        const [n] = runCredits([c]).fired;
        assertEqual(n.title, `OpenAI — reset credit expires ${localDateHm(c.expiresAt)}`);
        assertEqual(n.body, `Reset credit — redeem within ${formatCountdown(c.expiresAt, NOW)} (${localTimeHm(c.expiresAt)})`);
    });
});

describe('state (de)serialization', () => {
    it('round-trips', () => {
        const {state} = run([row(97)]);
        assertDeepEqual(parseState(serializeState(state)), state);
        assertEqual(state.version, STATE_VERSION);
    });

    it('the old three-line text format is discarded', () => {
        assertDeepEqual(parseState('95\n1780000000000\n2026-06-08T12:00:00.000Z'), {version: STATE_VERSION, entries: {}});
    });

    it('empty, corrupt or foreign-version state counts as nothing notified', () => {
        for (const text of ['', '{', 'null', '[]', '{"version":1,"entries":{}}', '{"version":2,"entries":[]}'])
            assertDeepEqual(parseState(text), {version: STATE_VERSION, entries: {}}, text);
    });

    it('a restored state keeps a crossing marked', () => {
        const saved = serializeState(run([row(97)]).state);
        assertEqual(run([row(98)], parseState(saved)).fired.length, 0);
    });
});

system.exit(summary());
