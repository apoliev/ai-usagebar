import system from 'system';

import {
    parseUsage, primaryQuota, peakUsage, severity, placeholders, fakeSnapshot,
    notifyRows, resetCredits, mergeQuotas, snapshotToCacheJson, parseCacheJson, CACHE_VERSION,
} from '../../../../lib/vendors/sourcecraft/parser.js';
import {Severity} from '../../../../lib/severity.js';
import {describe, it, assertEqual, assertDeepEqual, assertThrows, summary} from '../../../_assert.js';

const parse = quotas => parseUsage(JSON.stringify({quotas}), 'example');

describe('SourceCraft quotas', () => {
    it('treats the personal subscription quota as primary', () => {
        const s = parse([
            {quota_id: 'src.completionRequests.count', usage: 21, limit: 4000},
            {quota_id: 'src.cu.count', usage: 1000, limit: 4000},
        ]);
        assertEqual(s.quotas[0].kind, 'subscription');
        assertEqual(primaryQuota(s).kind, 'subscription');
        assertEqual(peakUsage(s).percent, 25);
        assertEqual(placeholders(s).get('sourcecraft_quota'), 'subscription');
    });
    it('selects monthly AI quota over exhausted bonuses and excludes non-AI quotas', () => {
        const s = parse([
            {quota_id: 'src.cuOneTimeGift.count', usage: 100, limit: 100},
            {quota_id: 'src.repositories.count', usage: 100, limit: 100},
            {quota_id: 'src.cuPrepaidRaw.count', usage: 425.5, limit: 1000},
        ]);
        assertEqual(s.quotas.length, 2);
        assertEqual(primaryQuota(s).kind, 'monthly');
        assertEqual(peakUsage(s).percent, 43);
        assertEqual(peakUsage(s).resetsAt, null);
        assertEqual(placeholders(s).get('sourcecraft_remaining'), '574.5');
        assertEqual(placeholders(s).get('session_reset'), '—');
    });
    it('supports the older prepaid ID without double-counting aliases', () => {
        assertEqual(primaryQuota(parse([
            {quota_id: 'src.cuPrepaid.count', usage: 5, limit: 10},
        ])).percent, 50);
        const s = parse([
            {quota_id: 'src.cuPrepaid.count', usage: 8, limit: 10},
            {quota_id: 'src.cuPrepaidRaw.count', usage: 2, limit: 10},
        ]);
        assertEqual(s.quotas.length, 1);
        assertEqual(primaryQuota(s).percent, 20);
    });
    it('handles zero limits without inventing a usage percentage', () => {
        const s = parse([{quota_id: 'src.cuFlexible.count', usage: 0, limit: 0}]);
        assertEqual(s.quotas[0].percent, null);
        assertEqual(peakUsage(s).percent, null);
        assertEqual(placeholders(s).get('session_pct'), '—');
    });
    it('falls back to the bonus quota for free accounts', () => {
        const s = parse([
            {quota_id: 'src.cuPrepaidRaw.count', usage: 0, limit: 0},
            {quota_id: 'src.cuOneTimeGift.count', usage: 95, limit: 100},
        ]);
        assertEqual(primaryQuota(s).kind, 'bonus');
        assertEqual(severity(s), Severity.CRITICAL);
    });
    it('clamps over-quota usage but retains the actual counts', () => {
        const s = parse([{quota_id: 'src.completionRequests.count', usage: 12, limit: 10}]);
        assertEqual(primaryQuota(s).percent, 100);
        assertEqual(primaryQuota(s).usage, 12);
        assertEqual(placeholders(s).get('sourcecraft_remaining'), '0');
    });
    it('distinguishes missing AI quotas from zero usage', () => {
        const s = parse([null, {quota_id: 'unrelated', usage: 1, limit: 2}]);
        assertEqual(s.quotas.length, 0);
        assertEqual(placeholders(s).get('session_pct'), '—');
    });
    it('rejects malformed responses and invalid known quota values', () => {
        for (const text of ['null', '{}', '[]', 'not json', '{"quotas":{}}'])
            assertThrows(() => parseUsage(text));
        for (const usage of [null, '5', -1])
            assertThrows(() => parse([{quota_id: 'src.cuFlexible.count', usage, limit: 10}]));
        assertThrows(() => parse([{quota_id: 'src.cuFlexible.count', usage: 0, limit: -1}]));
    });
    it('parses byte responses and renders synthetic data', () => {
        const s = parseUsage(new TextEncoder().encode('{"quotas":[]}'), 'example');
        assertEqual(s.organization, 'example');
        assertEqual(peakUsage(fakeSnapshot(25)).percent, 25);
    });
});

describe('SourceCraft mergeQuotas', () => {
    const mk = (kind, usage, limit) => ({
        kind, id: `src.${kind}.count`, usage, limit,
        percent: limit > 0 ? Math.min(100, Math.round(usage / limit * 100)) : null,
    });

    it('personal wins per kind and retires the archived prepaid bucket', () => {
        const merged = mergeQuotas(
            [mk('subscription', 10, 100)],
            [mk('monthly', 20, 100), mk('extra', 0, 0), mk('completions', 3, 10)]
        );
        assertDeepEqual(merged.map(q => q.kind), ['subscription', 'extra', 'completions']);
    });

    it('without a subscription the org buckets pass through untouched', () => {
        const org = [mk('monthly', 20, 100), mk('completions', 3, 10)];
        assertDeepEqual(mergeQuotas([], org), org);
    });

    it('never duplicates a kind the personal answer already reported', () => {
        const merged = mergeQuotas(
            [mk('monthly', 1, 10), mk('completions', 2, 10)],
            [mk('monthly', 9, 10), mk('completions', 8, 10), mk('extra', 1, 10)]
        );
        assertDeepEqual(merged.map(q => q.kind), ['monthly', 'completions', 'extra']);
        assertEqual(merged[0].usage, 1);
    });
});

describe('SourceCraft notifyRows / resetCredits', () => {
    it('lists one row per reported quota with an organization-scoped key', () => {
        const s = parse([
            {quota_id: 'src.cuPrepaidRaw.count', usage: 95, limit: 100},
            {quota_id: 'src.cuOneTimeGift.count', usage: 10, limit: 100},
            {quota_id: 'src.cuFlexible.count', usage: 0, limit: 0},
        ]);
        const rows = notifyRows(s, t => `t:${t}`);
        assertDeepEqual(rows.map(r => r.key), ['example:monthly', 'example:bonus']);
        assertDeepEqual(rows.map(r => r.percent), [95, 10]);
        assertDeepEqual(rows.map(r => r.resetsAt), [null, null]);
        assertEqual(rows[0].label, 't:Monthly AI quota');
        assertEqual(rows[1].label, 't:Bonus AI quota');
    });

    it('another organization yields different keys, so neither silences the other', () => {
        const quotas = [{quota_id: 'src.cuPrepaidRaw.count', usage: 98, limit: 100}];
        const a = notifyRows(parseUsage(JSON.stringify({quotas}), 'org-a'));
        const b = notifyRows(parseUsage(JSON.stringify({quotas}), 'org-b'));
        assertEqual(a[0].key !== b[0].key, true);
    });

    it('no quotas → no rows; reset credits never appear', () => {
        assertDeepEqual(notifyRows(parse([])), []);
        assertDeepEqual(resetCredits(parse([
            {quota_id: 'src.cuPrepaidRaw.count', usage: 1, limit: 2},
        ])), []);
    });
});

describe('SourceCraft snapshot cache', () => {
    it('round-trips the snapshot and re-applies the current organization', () => {
        const s = parse([
            {quota_id: 'src.cuPrepaidRaw.count', usage: 25, limit: 100},
            {quota_id: 'src.cuFlexible.count', usage: 0, limit: 0},
        ]);
        const back = parseCacheJson(snapshotToCacheJson(s));
        assertDeepEqual(back, s);
        assertEqual(back.quotas[0].percent, 25);
        assertEqual(back.quotas[1].percent, null);
    });

    it('a raw body or another version is rejected as corrupt', () => {
        assertThrows(() => parseCacheJson('{"quotas":[]}'));
        assertThrows(() => parseCacheJson(JSON.stringify({cacheVersion: 1, snapshot: {}})));
        assertThrows(() => parseCacheJson(JSON.stringify({cacheVersion: CACHE_VERSION + 1, snapshot: {}})));
        assertThrows(() => parseCacheJson('not json'));
    });
});

system.exit(summary());
