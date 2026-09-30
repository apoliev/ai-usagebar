import {severityColor, severityFor} from './severity.js';
import {paceSeverity} from './pacing.js';

// Pure decision logic for the two-colour popup usage bar — gi://-free.
//
// The fill is split at the pace marker (elapsed% of the window): the calm
// stretch up to the marker is coloured from `pct` (severityFor — the pct→colour
// mapping), and the stretch that overshoots the marker from the pace delta
// `pct - elapsedPct` (paceSeverity — the delta→colour mapping). Mirrors the
// upstream `barMarkup`/`colorForPct`/`colorForDelta` blueprint. `over` is null
// when there is no marker, so callers keep a single-colour fill.

// A window at its cap has no pace left to show: the fill stays single-colour.
export function fillColors(pct, elapsedPct, theme) {
    const base = severityColor(severityFor(pct), theme);
    const over = typeof elapsedPct === 'number' && pct < 100
        ? severityColor(paceSeverity(pct - elapsedPct), theme)
        : null;
    return {base, over};
}

function clampFraction(f) {
    if (!(f > 0))
        return 0;
    return f > 1 ? 1 : f;
}

// Pixel geometry for the fill split, kept here so it is unit-testable without
// Clutter. `markerFraction === null` → a single base segment spanning the whole
// fill (marker absent). Otherwise the fill splits at the marker: [0, markerX)
// is the base colour and [markerX, fillW) the pace colour — except for a full
// bar, which has no pace tail.
export function fillSegments(fraction, markerFraction, width, markerW = 2) {
    const fillW = Math.round(clampFraction(fraction) * width);
    if (markerFraction === null || markerFraction === undefined)
        return {fillW, markerX: null, baseW: fillW, overW: 0};

    const maxX = Math.max(0, width - markerW);
    let markerX = Math.round(clampFraction(markerFraction) * width);
    if (markerX > maxX)
        markerX = maxX;

    if (clampFraction(fraction) >= 1)
        return {fillW, markerX, baseW: fillW, overW: 0};

    const baseW = Math.min(fillW, markerX);
    const overW = Math.max(0, fillW - markerX);
    return {fillW, markerX, baseW, overW};
}
