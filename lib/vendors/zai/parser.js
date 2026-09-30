import {severityFor} from '../../severity.js';
import {format as formatCountdown} from '../../countdown.js';
import {calc, paceGlyph} from '../../pacing.js';
import {fakeWindow} from '../fake.js';
import {sanitizeUntrusted} from '../../format.js';
import {encodeSnapshot, decodeSnapshot} from '../snapshot-cache.js';

export const ICON = '󰚩';
export const VENDOR_SHORT = 'zai';
export const SESSION_MS = 5 * 3600 * 1000;
export const WEEKLY_MS = 7 * 86400 * 1000;
export const MCP_MS = 30 * 86400 * 1000;

export class SchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SchemaError';
    }
}

function capitalize(s) {
    if (!s)
        return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

const UNIT_SESSION = 3;
const UNIT_WEEKLY = 6;
const USAGE_TYPES = new Set(['TOKENS_LIMIT', 'CREDIT_LIMIT']);

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function percentage(l) {
    const p = l.percentage;
    if (p === undefined || p === null)
        return null;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 101)
        throw new SchemaError(`zai: percentage ${JSON.stringify(p)} outside 0..=100`);
    return p;
}

function resetTime(l) {
    const ms = l.nextResetTime;
    if (ms === undefined || ms === null || ms === 0)
        return null;
    if (!Number.isSafeInteger(ms) || ms < 0)
        throw new SchemaError(`zai: nextResetTime ${JSON.stringify(ms)} is not a non-negative integer`);
    return new Date(ms);
}

function uniqueByUnit(buckets, unit) {
    const matching = buckets.filter(l => l.unit === unit);
    if (matching.length > 1)
        throw new SchemaError(`zai: unrecognised limits layout: two usage buckets carry unit ${unit}`);
    return matching[0] ?? null;
}

// Buckets are identified by `unit` (3 = 5h, 6 = weekly), never by position;
// an unknown unit is dropped, but a layout with no known unit is drift.
function classify(limits) {
    const entries = limits.filter(isObject);
    const usage = entries.filter(l => USAGE_TYPES.has(l.type));
    let session = null;
    let weekly = null;
    if (usage.length > 0) {
        if (usage.every(l => l.unit === undefined || l.unit === null))
            throw new SchemaError('zai: unrecognised limits layout: usage buckets carry no unit discriminator');
        session = uniqueByUnit(usage, UNIT_SESSION);
        weekly = uniqueByUnit(usage, UNIT_WEEKLY);
        if (session === null && weekly === null) {
            throw new SchemaError('zai: unrecognised limits layout: no usage bucket carries a known unit code ' +
                `(saw ${usage.map(l => l.unit).join(', ')})`);
        }
    }
    const time = entries.filter(l => l.type === 'TIME_LIMIT');
    if (time.length > 1)
        throw new SchemaError('zai: unrecognised limits layout: two TIME_LIMIT buckets are present');
    return {session, weekly, mcp: time[0] ?? null};
}

function limitsOf(data) {
    if (data.limits === undefined || data.limits === null)
        return [];
    if (!Array.isArray(data.limits))
        throw new SchemaError('zai: data.limits is not a list');
    return data.limits;
}

// A 200 can still carry `success:false` or `data:null`; neither may reach the cache.
export function validateEnvelope(obj) {
    if (!isObject(obj))
        throw new SchemaError('zai quota response: top-level value is not an object');
    const hasCode = obj.code !== undefined && obj.code !== null;
    if (obj.success !== true || (hasCode && obj.code !== 200)) {
        const msg = typeof obj.msg === 'string' && obj.msg !== '' ? obj.msg : 'no message';
        throw new SchemaError(`zai: API reported failure (code ${obj.code ?? 'none'}, success ${obj.success ?? 'none'}): ${msg}`);
    }
    if (!isObject(obj.data))
        throw new SchemaError('zai: success response carried no `data`');
    const buckets = classify(limitsOf(obj.data));
    for (const [label, bucket] of [['session', buckets.session], ['weekly', buckets.weekly], ['MCP', buckets.mcp]]) {
        if (bucket !== null && percentage(bucket) === null)
            throw new SchemaError(`zai: ${label} limit carried no percentage`);
    }
    return buckets;
}

function toWindow(l, windowMs) {
    if (l === null)
        return null;
    const utilizationPct = Math.min(100, Math.round(percentage(l)));
    return {utilizationPct, resetsAt: resetTime(l), windowMs};
}

export function parseEnvelope(bytesOrText, configPlanTier) {
    const text = bytesOrText instanceof Uint8Array
        ? new TextDecoder().decode(bytesOrText)
        : String(bytesOrText);

    let obj;
    try {
        obj = JSON.parse(text);
    } catch (e) {
        throw new SchemaError(`zai quota response unparseable: ${e?.message ?? e}`);
    }
    const buckets = validateEnvelope(obj);

    const levelRaw = typeof obj.data.level === 'string' ? sanitizeUntrusted(obj.data.level, 64) : '';
    const level = levelRaw || configPlanTier || 'unknown';
    const plan = `GLM Coding ${capitalize(level)}`;

    return {
        plan,
        session: toWindow(buckets.session, SESSION_MS),
        weekly: toWindow(buckets.weekly, WEEKLY_MS),
        mcp: toWindow(buckets.mcp, MCP_MS),
    };
}

// Dev-only synthetic snapshot at a fixed percentage (AI_USAGEBAR_FAKE_PCT).
export function fakeSnapshot(pct, now = new Date()) {
    return {
        plan: 'GLM Coding Pro (fake)',
        session: fakeWindow(pct, SESSION_MS, now),
        weekly: fakeWindow(pct, WEEKLY_MS, now),
        mcp: fakeWindow(pct, MCP_MS, now),
    };
}

// Peak utilization and the resets_at of the window that produced it.
export function zaiPeakUsage(snapshot) {
    let percent = 0;
    let resetsAt = null;
    for (const w of [snapshot.session, snapshot.weekly, snapshot.mcp]) {
        if (w && w.utilizationPct > percent) {
            percent = w.utilizationPct;
            resetsAt = w.resetsAt;
        }
    }
    return {percent, resetsAt};
}

export function zaiSeverity(snapshot) {
    return severityFor(zaiPeakUsage(snapshot).percent);
}

function windowPace(win, now) {
    if (!win)
        return {elapsed: '0', pace: '', indicator: ''};
    const pace = calc({usagePct: win.utilizationPct, reset: win.resetsAt, now, windowMs: win.windowMs});
    return {
        elapsed: String(pace.elapsedPct),
        pace: paceGlyph(pace.ratioPace, pace.state),
        indicator: paceGlyph(pace.pointPace, pace.state),
    };
}

export function placeholders(snapshot, now) {
    const m = new Map();
    const sPct = snapshot.session ? snapshot.session.utilizationPct : 0;
    const wPct = snapshot.weekly ? snapshot.weekly.utilizationPct : 0;
    const mPct = snapshot.mcp ? snapshot.mcp.utilizationPct : 0;
    const sReset = formatCountdown(snapshot.session ? snapshot.session.resetsAt : null, now);
    const wReset = formatCountdown(snapshot.weekly ? snapshot.weekly.resetsAt : null, now);
    const mReset = formatCountdown(snapshot.mcp ? snapshot.mcp.resetsAt : null, now);

    m.set('icon', ICON);
    m.set('vendor_short', VENDOR_SHORT);
    m.set('session_pct', String(sPct));
    m.set('session_reset', sReset);
    m.set('weekly_pct', String(wPct));
    m.set('weekly_reset', wReset);
    m.set('plan', snapshot.plan);

    m.set('zai_plan', snapshot.plan);
    m.set('zai_session_pct', String(sPct));
    m.set('zai_session_reset', sReset);
    m.set('zai_weekly_pct', String(wPct));
    m.set('zai_weekly_reset', wReset);
    m.set('zai_mcp_pct', String(mPct));
    m.set('zai_mcp_reset', mReset);

    const paces = {session: windowPace(snapshot.session, now), weekly: windowPace(snapshot.weekly, now), mcp: windowPace(snapshot.mcp, now)};
    for (const [name, p] of Object.entries(paces)) {
        m.set(`zai_${name}_elapsed`, p.elapsed);
        m.set(`zai_${name}_pace`, p.pace);
        m.set(`zai_${name}_pace_indicator`, p.indicator);
    }
    m.set('session_elapsed', paces.session.elapsed);
    m.set('session_pace', paces.session.pace);
    m.set('weekly_elapsed', paces.weekly.elapsed);
    m.set('weekly_pace', paces.weekly.pace);

    return m;
}

export function notifyRows(snapshot, _ = (s) => s) {
    const windows = [
        ['session', _('Session (5h)'), snapshot.session],
        ['weekly', _('Weekly'), snapshot.weekly],
        ['mcp', _('MCP tools (monthly)'), snapshot.mcp],
    ];
    return windows.filter(([, , w]) => w)
        .map(([key, label, w]) => ({key, label, percent: w.utilizationPct, resetsAt: w.resetsAt}));
}

export function resetCredits(_snapshot) {
    return [];
}

export const CACHE_VERSION = 1;

export function snapshotToCacheJson(snapshot) {
    return encodeSnapshot(snapshot, CACHE_VERSION);
}

export function parseCacheJson(bytesOrText) {
    return decodeSnapshot(bytesOrText, CACHE_VERSION, SchemaError);
}
