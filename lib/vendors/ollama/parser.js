import {severityFor} from '../../severity.js';
import {format as formatCountdown} from '../../countdown.js';
import {fakeWindow} from '../fake.js';
import {sanitizeUntrusted} from '../../format.js';
import {encodeSnapshot, decodeSnapshot} from '../snapshot-cache.js';

// Nerd Fonts has no llama glyph; md-robot, like the other API-key vendors.
export const ICON = '󰚩';
export const VENDOR_SHORT = 'oll';
export const SESSION_MS = 5 * 3600 * 1000;
export const WEEKLY_MS = 7 * 86400 * 1000;
export const MONTHLY_MS = 30 * 86400 * 1000;
export const TOP_MODELS = 5;

const WINDOWS = Object.freeze([['session', SESSION_MS], ['weekly', WEEKLY_MS], ['monthly', MONTHLY_MS]]);

export class SchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SchemaError';
    }
}

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// `usage` is a fraction; anything past [0, 1] saturates, absent is 0%.
function usagePct(v, name) {
    if (v === undefined || v === null)
        return 0;
    if (typeof v !== 'number' || !Number.isFinite(v))
        throw new SchemaError(`ollama: limits.${name}.usage is not a number`);
    return Math.round(Math.min(1, Math.max(0, v)) * 100);
}

function requestCount(v) {
    return Number.isInteger(v) && v > 0 ? v : 0;
}

function parseModels(list, name) {
    if (list === undefined || list === null)
        return {models: [], totalRequests: 0};
    if (!Array.isArray(list))
        throw new SchemaError(`ollama: limits.${name}.models is not a list`);
    const all = list
        .filter(m => isObject(m) && typeof m.name === 'string' && m.name.trim() !== '')
        .map(m => ({name: sanitizeUntrusted(m.name.trim(), 64), requestCount: requestCount(m.request_count)}));
    const totalRequests = all.reduce((n, m) => n + m.requestCount, 0);
    const models = all.sort((a, b) => b.requestCount - a.requestCount).slice(0, TOP_MODELS);
    return {models, totalRequests};
}

// The JSON route carries no reset instant, so every window has only its
// nominal length.
function parseWindow(w, name, windowMs) {
    if (w === undefined || w === null)
        return null;
    if (!isObject(w))
        throw new SchemaError(`ollama: limits.${name} is not an object`);
    return {utilizationPct: usagePct(w.usage, name), resetsAt: null, windowMs, ...parseModels(w.models, name)};
}

// `plan` comes from the prefs: the route sends no plan field.
export function parseUsage(bytesOrText, plan = null) {
    const text = bytesOrText instanceof Uint8Array
        ? new TextDecoder().decode(bytesOrText)
        : String(bytesOrText);
    let obj;
    try {
        obj = JSON.parse(text);
    } catch (e) {
        throw new SchemaError(`ollama: usage response unparseable: ${e?.message ?? e}`);
    }
    if (!isObject(obj))
        throw new SchemaError('ollama: top-level value is not an object');
    const limits = obj.limits ?? {};
    if (!isObject(limits))
        throw new SchemaError('ollama: limits is not an object');

    const snapshot = {plan: plan || null};
    for (const [name, windowMs] of WINDOWS)
        snapshot[name] = parseWindow(limits[name], name, windowMs);

    const activity = isObject(obj.activity) ? obj.activity : {};
    snapshot.cost = typeof activity.cost === 'string' ? sanitizeUntrusted(activity.cost, 32) : null;
    snapshot.period = isObject(activity.period) && typeof activity.period.type === 'string'
        ? sanitizeUntrusted(activity.period.type, 32)
        : null;
    return snapshot;
}

export function fakeSnapshot(pct, now = new Date()) {
    const models = [
        {name: 'kimi-k3', requestCount: 180},
        {name: 'minimax-m3', requestCount: 120},
        {name: 'deepseek-v4-flash', requestCount: 27},
        {name: 'glm-5.3-flash', requestCount: 8},
        {name: 'gpt-oss:120b', requestCount: 2},
    ];
    const win = windowMs => ({...fakeWindow(pct, windowMs, now), resetsAt: null, models, totalRequests: 340});
    return {plan: 'Pro (fake)', session: win(SESSION_MS), weekly: win(WEEKLY_MS), monthly: null, cost: '0.00000', period: 'last_4_weeks'};
}

function presentWindows(snapshot) {
    return WINDOWS.map(([name]) => [name, snapshot[name]]).filter(([, w]) => w);
}

export function ollamaPeakUsage(snapshot) {
    const pcts = presentWindows(snapshot).map(([, w]) => w.utilizationPct);
    return {percent: pcts.length ? Math.max(...pcts) : 0, resetsAt: null};
}

export function ollamaSeverity(snapshot) {
    return severityFor(ollamaPeakUsage(snapshot).percent);
}

export function planLabel(snapshot) {
    return snapshot.plan ?? 'Ollama';
}

export function placeholders(snapshot, now) {
    const m = new Map();
    m.set('icon', ICON);
    m.set('vendor_short', VENDOR_SHORT);
    m.set('plan', planLabel(snapshot));
    m.set('oll_plan', planLabel(snapshot));
    m.set('oll_cost', snapshot.cost ?? '—');

    for (const [name] of WINDOWS) {
        const w = snapshot[name];
        m.set(`oll_${name}_pct`, w ? String(w.utilizationPct) : '');
        m.set(`oll_${name}_reset`, formatCountdown(null, now));
        m.set(`oll_${name}_elapsed`, '0');
    }
    for (const alias of ['session', 'weekly']) {
        m.set(`${alias}_pct`, m.get(`oll_${alias}_pct`));
        m.set(`${alias}_reset`, m.get(`oll_${alias}_reset`));
        m.set(`${alias}_elapsed`, '0');
    }
    return m;
}

export function notifyRows(snapshot, _ = (s) => s) {
    const labels = {session: _('Session'), weekly: _('Weekly'), monthly: _('Monthly')};
    return presentWindows(snapshot)
        .map(([key, w]) => ({key, label: labels[key], percent: w.utilizationPct, resetsAt: null}));
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
