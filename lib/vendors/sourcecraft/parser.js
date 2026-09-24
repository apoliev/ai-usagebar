import {severityFor} from '../../severity.js';

export const ICON = '󰚩';
export const VENDOR_SHORT = 'src';

// IDs used by SourceCraft's Code Assistant settings UI.
export const QUOTA_IDS = Object.freeze({
    monthly: ['src.cuPrepaidRaw.count', 'src.cuPrepaid.count'],
    bonus: ['src.cuOneTimeGift.count'],
    extra: ['src.cuFlexible.count'],
    completions: ['src.completionRequests.count'],
});

export function parseUsage(bytesOrText, organization = '') {
    const text = bytesOrText instanceof Uint8Array
        ? new TextDecoder().decode(bytesOrText) : String(bytesOrText);
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.quotas))
        throw new Error('SourceCraft: invalid quota response');

    const quotas = [];
    for (const [kind, ids] of Object.entries(QUOTA_IDS)) {
        const q = ids.map(id => obj.quotas.find(item => item?.quota_id === id)).find(Boolean);
        if (!q)
            continue;
        if (!Number.isFinite(q.usage) || q.usage < 0 || !Number.isFinite(q.limit) || q.limit < 0)
            throw new Error(`SourceCraft: invalid ${kind} quota values`);
        const percent = q.limit > 0
            ? Math.min(100, Math.round(q.usage / q.limit * 100)) : null;
        quotas.push({kind, id: q.quota_id, usage: q.usage, limit: q.limit, percent});
    }
    return {plan: 'SourceCraft Code Assistant', organization, quotas};
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

export function fakeSnapshot(pct) {
    return parseUsage(JSON.stringify({quotas: [{
        quota_id: QUOTA_IDS.monthly[0],
        usage: Math.min(100, Math.max(0, pct)),
        limit: 100,
    }]}), 'demo');
}
