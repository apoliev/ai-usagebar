import {severityFor} from '../../severity.js';
import {sanitizeUntrusted} from '../../format.js';
import {encodeSnapshot, decodeSnapshot} from '../snapshot-cache.js';

export const ICON = '󰚩';
export const VENDOR_SHORT = 'src';
export const CACHE_VERSION = 1;

export class SchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SchemaError';
    }
}

// IDs used by SourceCraft's Code Assistant settings UI.
export const QUOTA_IDS = Object.freeze({
    monthly: ['src.cuPrepaidRaw.count', 'src.cuPrepaid.count'],
    bonus: ['src.cuOneTimeGift.count'],
    extra: ['src.cuFlexible.count'],
    completions: ['src.completionRequests.count'],
});

export function quotaLabel(kind, _ = (s) => s) {
    switch (kind) {
    case 'monthly':
        return _('Monthly AI quota');
    case 'bonus':
        return _('Bonus AI quota');
    case 'extra':
        return _('Extra neurocredits');
    default:
        return _('Code completions');
    }
}

export function parseUsage(bytesOrText, organization = '') {
    const text = bytesOrText instanceof Uint8Array
        ? new TextDecoder().decode(bytesOrText) : String(bytesOrText);
    let obj;
    try {
        obj = JSON.parse(text);
    } catch (e) {
        throw new SchemaError('SourceCraft: invalid quota response');
    }
    if (!obj || !Array.isArray(obj.quotas))
        throw new SchemaError('SourceCraft: invalid quota response');

    const quotas = [];
    for (const [kind, ids] of Object.entries(QUOTA_IDS)) {
        const q = ids.map(id => obj.quotas.find(item => item?.quota_id === id)).find(Boolean);
        if (!q)
            continue;
        if (!Number.isFinite(q.usage) || q.usage < 0 || !Number.isFinite(q.limit) || q.limit < 0)
            throw new SchemaError(`SourceCraft: invalid ${kind} quota values`);
        const percent = q.limit > 0
            ? Math.min(100, Math.round(q.usage / q.limit * 100)) : null;
        quotas.push({kind, id: q.quota_id, usage: q.usage, limit: q.limit, percent});
    }
    return {plan: 'SourceCraft Code Assistant', organization: sanitizeUntrusted(organization, 64), quotas};
}

export function primaryQuota(snapshot) {
    return snapshot.quotas.find(q => q.limit > 0) ?? null;
}

export function peakUsage(snapshot) {
    return {percent: primaryQuota(snapshot)?.percent ?? null, resetsAt: null};
}

export function severity(snapshot) {
    return severityFor(peakUsage(snapshot).percent ?? 0);
}

export function placeholders(snapshot) {
    const q = primaryQuota(snapshot);
    return new Map([
        ['icon', ICON], ['vendor_short', VENDOR_SHORT], ['plan', snapshot.plan],
        ['session_pct', q ? String(q.percent) : '—'], ['session_reset', '—'],
        ['weekly_pct', '—'], ['weekly_reset', '—'],
        ['sourcecraft_usage', q ? String(q.usage) : '—'],
        ['sourcecraft_limit', q ? String(q.limit) : '—'],
        ['sourcecraft_remaining', q ? String(Math.max(0, q.limit - q.usage)) : '—'],
        ['sourcecraft_organization', snapshot.organization],
        ['sourcecraft_quota', q?.kind ?? '—'],
    ]);
}

// The dedupe key carries the organization, so two organizations sharing the
// vendor's `.notified` sidecar never silence each other.
export function notifyRows(snapshot, _ = (s) => s) {
    return snapshot.quotas
        .filter(q => q.percent !== null)
        .map(q => ({
            key: `${snapshot.organization}:${q.kind}`,
            label: quotaLabel(q.kind, _),
            percent: q.percent,
            resetsAt: null,
        }));
}

export function resetCredits(_snapshot) {
    return [];
}

export function snapshotToCacheJson(snapshot) {
    return encodeSnapshot(snapshot, CACHE_VERSION);
}

export function parseCacheJson(bytesOrText) {
    return decodeSnapshot(bytesOrText, CACHE_VERSION, SchemaError);
}

export function fakeSnapshot(pct) {
    return parseUsage(JSON.stringify({quotas: [{
        quota_id: QUOTA_IDS.monthly[0],
        usage: Math.min(100, Math.max(0, pct)),
        limit: 100,
    }]}), 'demo');
}
