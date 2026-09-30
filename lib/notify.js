import {vformat, localTimeHm} from './format.js';
import {format as formatCountdown, localDateHm} from './countdown.js';

export const STATE_VERSION = 2;
export const HYSTERESIS_PCT = 7;
export const CREDIT_WARNING_MS = 48 * 3600 * 1000;

export const Urgency = Object.freeze({
    NORMAL: 'normal',
    CRITICAL: 'critical',
});

function emptyState() {
    return {version: STATE_VERSION, entries: {}};
}

// Anything but our own version — the old three-line text, a corrupt file —
// counts as nothing notified: never pinned silent, never stuck re-firing.
export function parseState(text) {
    try {
        const obj = JSON.parse(text);
        if (obj?.version !== STATE_VERSION || typeof obj.entries !== 'object' || obj.entries === null ||
            Array.isArray(obj.entries))
            return emptyState();
        return {version: STATE_VERSION, entries: {...obj.entries}};
    } catch (_e) {
        return emptyState();
    }
}

export function serializeState(state) {
    return JSON.stringify(state);
}

function ms(date) {
    return date instanceof Date ? date.getTime() : null;
}

// A new window: the reset moved later, or one appeared where none was reported.
function resetMovedLater(current, recorded) {
    if (current === null)
        return false;
    return recorded === null || recorded === undefined || current > recorded;
}

function thresholdNotification(vendor, row, now, _) {
    // Translators: "Claude — Session at 97%": the vendor, the usage window, then the percentage.
    const title = vformat(_('%s — %s at %d%%'), vendor, row.label, row.percent);
    let body = vformat(_('%d%% of the %s used'), row.percent, row.label);
    if (row.resetsAt)
        // Translators: appended to the body — " · resets 2h 05m (16:00)".
        body += vformat(_(' · resets %s (%s)'), formatCountdown(row.resetsAt, now, _), localTimeHm(row.resetsAt));
    return {title, body, urgency: row.percent >= 100 ? Urgency.CRITICAL : Urgency.NORMAL};
}

function creditNotification(vendor, credit, now, _) {
    return {
        // Translators: "Claude — reset credit expires Oct 22 16:00".
        title: vformat(_('%s — reset credit expires %s'), vendor, localDateHm(credit.expiresAt)),
        // Translators: "Full reset — redeem within 1d 4h (16:00)".
        body: vformat(_('%s — redeem within %s (%s)'), credit.title || _('Reset credit'),
            formatCountdown(credit.expiresAt, now, _), localTimeHm(credit.expiresAt)),
        urgency: Urgency.NORMAL,
    };
}

// Pure: which notifications one fresh refresh raises, and the state to
// persist before any of them is delivered. A key fires once per crossing and
// re-arms when usage drops below threshold - 7 or the window resets later.
export function decide({vendor, rows, credits, threshold, previous, now, _ = (s) => s}) {
    const entries = {...previous?.entries ?? {}};
    const fired = [];
    const nowMs = now.getTime();

    for (const row of rows) {
        const key = `${vendor}::${row.key}`;
        const resetMs = ms(row.resetsAt);
        if (row.percent >= threshold) {
            const record = entries[key];
            if (!record || resetMovedLater(resetMs, record.resetAt)) {
                fired.push(thresholdNotification(vendor, row, now, _));
                entries[key] = {notifiedAt: nowMs, resetAt: resetMs};
            }
        } else if (row.percent < threshold - HYSTERESIS_PCT) {
            delete entries[key];
        }
    }

    for (const credit of credits) {
        const expiresMs = ms(credit.expiresAt);
        if (expiresMs === null)
            continue;
        const remaining = expiresMs - nowMs;
        if (remaining <= 0 || remaining > CREDIT_WARNING_MS)
            continue;
        const key = `${vendor}::credit::${credit.expiresAt.toISOString()}`;
        if (key in entries)
            continue;
        fired.push(creditNotification(vendor, credit, now, _));
        entries[key] = {notifiedAt: nowMs, resetAt: null};
    }

    return {fired, state: {version: STATE_VERSION, entries}};
}
