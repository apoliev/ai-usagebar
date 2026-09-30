export const DEFAULT_TOLERANCE = 5;

export const Pace = Object.freeze({
    AHEAD: 'ahead',
    ON_TRACK: 'on_track',
    UNDER: 'under',
});

export const PaceState = Object.freeze({
    OK: 'ok',
    ESTIMATING: 'estimating',
    LIMIT: 'limit',
    NEUTRAL: 'neutral',
});

// No glyph while there is nothing honest to say: too early in the window,
// already at the cap, or no reset to pace against.
export function paceGlyph(pace, state = PaceState.OK) {
    if (state !== PaceState.OK)
        return '';
    if (pace === Pace.AHEAD)
        return '↑';
    if (pace === Pace.UNDER)
        return '↓';
    return '→';
}

export const PaceSeverity = Object.freeze({
    LOW: 'low',
    MID: 'mid',
    HIGH: 'high',
    CRITICAL: 'critical',
});

export function paceSeverity(delta) {
    if (delta >= 10)
        return PaceSeverity.CRITICAL;
    if (delta > 0)
        return PaceSeverity.HIGH;
    if (delta >= -10)
        return PaceSeverity.MID;
    return PaceSeverity.LOW;
}

function neutral() {
    return {
        elapsedPct: 0,
        ratioPace: Pace.ON_TRACK,
        pointPace: Pace.ON_TRACK,
        delta: 0,
        ratioLabel: 'on track',
        pointLabel: 'on track',
        state: PaceState.NEUTRAL,
    };
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// The first minutes of a long window say nothing about pace: 1% of it,
// clamped to [60 s, 1 h].
function estimatingThresholdMs(windowMs) {
    return Math.min(HOUR_MS, Math.max(MINUTE_MS, windowMs * 0.01));
}

function paceState(usagePct, reset, now, windowMs) {
    if (usagePct >= 100)
        return PaceState.LIMIT;
    const remainingMs = reset.getTime() - now.getTime();
    const elapsedMs = windowMs - remainingMs;
    if (usagePct > 0 && remainingMs > 0 && elapsedMs < estimatingThresholdMs(windowMs))
        return PaceState.ESTIMATING;
    return PaceState.OK;
}

export function calc({usagePct, reset, now, windowMs, tolerance = DEFAULT_TOLERANCE}) {
    if (reset === null || reset === undefined)
        return neutral();
    if (windowMs <= 0)
        return neutral();

    const remaining = Math.trunc((reset.getTime() - now.getTime()) / 1000);
    const total = Math.trunc(windowMs / 1000);
    if (total <= 0)
        return neutral();

    let elapsedPct = Math.trunc(((total - remaining) * 100) / total);
    if (elapsedPct < 0)
        elapsedPct = 0;
    if (elapsedPct > 100)
        elapsedPct = 100;

    const delta = usagePct - elapsedPct;
    let pointPace, pointLabel;
    if (delta > 0) {
        pointPace = Pace.AHEAD;
        pointLabel = `${delta}pts ahead`;
    } else if (delta < 0) {
        pointPace = Pace.UNDER;
        pointLabel = `${-delta}pts under`;
    } else {
        pointPace = Pace.ON_TRACK;
        pointLabel = 'on track';
    }

    let ratioPace = Pace.ON_TRACK;
    let ratioLabel = 'on track';
    if (elapsedPct > 0) {
        const pacingX100 = Math.trunc((usagePct * 100) / elapsedPct);
        const tol = tolerance;
        if (pacingX100 > 100 + tol) {
            const dev = Math.min(pacingX100 - 100, 999);
            ratioPace = Pace.AHEAD;
            ratioLabel = `${dev}% ahead`;
        } else if (pacingX100 < 100 - tol) {
            const dev = Math.min(100 - pacingX100, 999);
            ratioPace = Pace.UNDER;
            ratioLabel = `${dev}% under`;
        }
    }

    const state = paceState(usagePct, reset, now, windowMs);
    return {elapsedPct, ratioPace, pointPace, delta, ratioLabel, pointLabel, state};
}
