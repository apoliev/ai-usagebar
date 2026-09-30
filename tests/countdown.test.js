import system from 'system';

import {format, formatBackoff, formatWithClock, resetClock, localDateHm} from '../lib/countdown.js';
import {localTimeHm} from '../lib/format.js';
import {describe, it, assertEqual, summary} from './_assert.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const now = new Date(2026, 4, 23, 12, 0, 0);
const at = offsetMs => new Date(now.getTime() + offsetMs);

describe('countdown.format', () => {
    it('null reset renders em-dash', () => {
        assertEqual(format(null, now), '—');
    });

    it('undefined reset renders em-dash', () => {
        assertEqual(format(undefined, now), '—');
    });

    it('past reset renders "now"', () => {
        assertEqual(format(at(-SECOND), now), 'now');
    });

    it('exactly 0 renders "now"', () => {
        assertEqual(format(now, now), 'now');
    });

    it('5h remaining → "5h 00m" (zero-padded minutes)', () => {
        assertEqual(format(at(5 * HOUR), now), '5h 00m');
    });

    it('1h 5m → "1h 05m" (zero-padded minutes)', () => {
        assertEqual(format(at(HOUR + 5 * MINUTE), now), '1h 05m');
    });

    it('23h 59m 59s → "23h 59m" (just under 1 day)', () => {
        assertEqual(format(at(23 * HOUR + 59 * MINUTE + 59 * SECOND), now), '23h 59m');
    });

    it('exactly 24h → "1d 0h" (1-day boundary, minutes dropped)', () => {
        assertEqual(format(at(DAY), now), '1d 0h');
    });

    it('1d 1h 30m → "1d 1h" (minutes dropped in day formatting)', () => {
        assertEqual(format(at(DAY + HOUR + 30 * MINUTE), now), '1d 1h');
    });

    it('4d 1h 45m → "4d 1h"', () => {
        assertEqual(format(at(4 * DAY + HOUR + 45 * MINUTE), now), '4d 1h');
    });

    it('1 second remaining → "0h 00m"', () => {
        assertEqual(format(at(SECOND), now), '0h 00m');
    });
});

describe('formatWithClock', () => {
    // `now` is local noon, so +4h05m stays on the same civil day in any zone.
    it('same local day: countdown · HH:MM', () => {
        const reset = at(4 * HOUR + 5 * MINUTE);
        assertEqual(resetClock(reset, now), localTimeHm(reset));
        assertEqual(formatWithClock(reset, now), `Resets in 4h 05m · ${localTimeHm(reset)}`);
    });

    it('another local day: countdown · locale date and time', () => {
        const reset = at(2 * DAY + 3 * HOUR);
        const clock = new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}).format(reset);
        assertEqual(resetClock(reset, now), clock);
        assertEqual(formatWithClock(reset, now), `Resets in 2d 3h · ${clock}`);
    });

    it('crossing local midnight counts as another day', () => {
        const reset = at(13 * HOUR);
        assertEqual(resetClock(reset, now) === localTimeHm(reset), false);
    });

    it('a reset in the past is due', () => {
        assertEqual(formatWithClock(at(-MINUTE), now), 'Reset due');
        assertEqual(formatWithClock(now, now), 'Reset due');
    });

    it('no reset renders nothing', () => {
        assertEqual(formatWithClock(null, now), '');
        assertEqual(formatWithClock(undefined, now), '');
    });

    it('routes its prose through the translator', () =>
        assertEqual(formatWithClock(at(-1), now, s => `«${s}»`), '«Reset due»'));
});

describe('formatBackoff', () => {
    it('seconds under a minute', () => {
        assertEqual(formatBackoff(0), '0s');
        assertEqual(formatBackoff(1), '1s');
        assertEqual(formatBackoff(59 * SECOND), '59s');
    });

    it('minutes rounded up under an hour', () => {
        assertEqual(formatBackoff(60 * SECOND), '1m');
        assertEqual(formatBackoff(61 * SECOND), '2m');
        assertEqual(formatBackoff(4 * MINUTE + 1), '5m');
        assertEqual(formatBackoff(59 * MINUTE), '59m');
    });

    it('hours and minutes from an hour on', () => {
        assertEqual(formatBackoff(HOUR), '1h 0m');
        assertEqual(formatBackoff(HOUR + 2 * MINUTE), '1h 2m');
        assertEqual(formatBackoff(HOUR + 90 * SECOND), '1h 2m');
    });

    it('routes the units through the translator', () =>
        assertEqual(formatBackoff(30 * SECOND, s => `«${s}»`), '«30s»'));
});

describe('countdown.format — injected translator', () => {
    // A fake translator wraps the format string in guillemets so we can prove the
    // unit labels route through `_()` (and are not hard-coded) and that vformat
    // still interpolates the translated template.
    const T = (s) => `«${s}»`;

    it('routes "now" through the translator', () => {
        assertEqual(format(at(-SECOND), now, T), '«now»');
    });

    it('routes the day/hour format through the translator', () => {
        assertEqual(format(at(DAY + HOUR), now, T), '«1d 1h»');
    });

    it('routes the hour/minute format through the translator', () => {
        assertEqual(format(at(HOUR + 5 * MINUTE), now, T), '«1h 05m»');
    });

    it('leaves the null em-dash marker untranslated', () => {
        assertEqual(format(null, now, T), '—');
    });
});

describe('localDateHm', () => {
    it('shows the date even on the same day', () => {
        const d = at(2 * HOUR);
        assertEqual(localDateHm(d) === localTimeHm(d), false);
        assertEqual(localDateHm(d).includes('23'), true);
    });

    it('matches resetClock on another day', () => {
        assertEqual(localDateHm(at(3 * DAY)), resetClock(at(3 * DAY), now));
    });
});

system.exit(summary());
