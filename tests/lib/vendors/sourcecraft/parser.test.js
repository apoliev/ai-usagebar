import system from 'system';

import {parseUsage, primaryQuota, peakUsage, severity, placeholders, fakeSnapshot} from '../../../../lib/vendors/sourcecraft/parser.js';
import {Severity} from '../../../../lib/severity.js';
import {describe, it, assertEqual, assertThrows, summary} from '../../../_assert.js';

const parse = quotas => parseUsage(JSON.stringify({quotas}), 'example');

describe('SourceCraft quotas', () => {
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

system.exit(summary());
