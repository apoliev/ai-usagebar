import system from 'system';

import {
    parseUsage, placeholders, notifyRows, resetCredits, ollamaPeakUsage, ollamaSeverity, fakeSnapshot,
    snapshotToCacheJson, parseCacheJson, SchemaError, SESSION_MS, WEEKLY_MS, MONTHLY_MS, VENDOR_SHORT,
} from '../../../../lib/vendors/ollama/parser.js';
import {Severity} from '../../../../lib/severity.js';
import {substitute} from '../../../../lib/format.js';
import {describe, it, assertEqual, assertDeepEqual, assertThrows, summary} from '../../../_assert.js';

// Real shape captured upstream on 2026-09-09 (Pro account, session + weekly).
const LIVE = JSON.stringify({
    activity: {
        cost: '0.00000',
        period: {type: 'last_4_weeks', starting_at: '2026-08-17T00:00:00Z', ending_at: '2026-09-09T18:28:57Z'},
        models: [{name: 'ignored', request_count: 999}],
    },
    limits: {
        session: {
            usage: 0.819,
            models: [
                {name: 'kimi-k3', request_count: 180},
                {name: 'deepseek-v4-flash:0731', request_count: 27},
                {name: 'minimax-m3', request_count: 8},
                {name: 'glm-5.3-flash', request_count: 8},
                {name: 'gpt-oss:120b', request_count: 2},
            ],
        },
        weekly: {
            usage: 0.23,
            models: [
                {name: 'kimi-k3', request_count: 180},
                {name: 'minimax-m3', request_count: 554},
                {name: 'deepseek-v4-flash:0731', request_count: 27},
                {name: 'qwen3.5:397b', request_count: 2},
                {name: 'glm-5.3-flash', request_count: 8},
                {name: 'gpt-oss:120b', request_count: 2},
            ],
        },
    },
});

const MONTHLY = JSON.stringify({limits: {monthly: {usage: 0.4, models: [{name: 'kimi-k3', request_count: 3}]}}});
const NOW = new Date('2026-09-09T18:30:00Z');

describe('parseUsage — session + weekly', () => {
    const s = parseUsage(LIVE, 'Pro');

    it('fractions become rounded percentages', () => {
        assertEqual(s.session.utilizationPct, 82);
        assertEqual(s.weekly.utilizationPct, 23);
        assertEqual(s.monthly, null);
    });

    it('windows carry no reset and their nominal length', () => {
        assertEqual(s.session.resetsAt, null);
        assertEqual(s.session.windowMs, SESSION_MS);
        assertEqual(s.weekly.windowMs, WEEKLY_MS);
    });

    it('models are per window, sorted by requests, top 5; activity.models is ignored', () => {
        assertDeepEqual(s.weekly.models.map(m => m.name),
            ['minimax-m3', 'kimi-k3', 'deepseek-v4-flash:0731', 'glm-5.3-flash', 'qwen3.5:397b']);
        assertEqual(s.weekly.models[0].requestCount, 554);
        assertEqual(s.session.models.length, 5);
        assertEqual(s.session.models.some(m => m.name === 'ignored'), false);
    });

    it('the request total counts every model, not just the top 5', () => {
        assertEqual(s.weekly.totalRequests, 180 + 554 + 27 + 2 + 8 + 2);
    });

    it('keeps the raw cost string and the period type', () => {
        assertEqual(s.cost, '0.00000');
        assertEqual(s.period, 'last_4_weeks');
    });

    it('takes the plan from the prefs', () => {
        assertEqual(s.plan, 'Pro');
        assertEqual(parseUsage(LIVE, '').plan, null);
        assertEqual(parseUsage(LIVE).plan, null);
    });
});

describe('parseUsage — edges', () => {
    it('monthly-only accounts', () => {
        const s = parseUsage(MONTHLY);
        assertEqual(s.session, null);
        assertEqual(s.weekly, null);
        assertEqual(s.monthly.utilizationPct, 40);
        assertEqual(s.monthly.windowMs, MONTHLY_MS);
    });

    it('an empty models list', () => {
        const s = parseUsage('{"limits":{"session":{"usage":0.1,"models":[]}}}');
        assertDeepEqual(s.session.models, []);
        assertEqual(s.session.totalRequests, 0);
    });

    it('a fraction above 1 saturates at 100, below 0 at 0; absent is 0', () => {
        assertEqual(parseUsage('{"limits":{"session":{"usage":1.4}}}').session.utilizationPct, 100);
        assertEqual(parseUsage('{"limits":{"session":{"usage":-0.2}}}').session.utilizationPct, 0);
        assertEqual(parseUsage('{"limits":{"session":{}}}').session.utilizationPct, 0);
    });

    it('request_count defaults to 0; a model without a name is skipped', () => {
        const s = parseUsage('{"limits":{"session":{"models":[{"name":"a"},{"request_count":5},{"name":"b","request_count":1}]}}}');
        assertDeepEqual(s.session.models, [{name: 'b', requestCount: 1}, {name: 'a', requestCount: 0}]);
    });

    it('no limits and no activity', () => {
        const s = parseUsage('{}');
        assertEqual(s.session, null);
        assertEqual(s.cost, null);
        assertEqual(s.period, null);
    });

    it('drift throws SchemaError', () => {
        for (const bad of ['nope', '[]', '{"limits":[]}', '{"limits":{"session":3}}',
            '{"limits":{"session":{"usage":"0.5"}}}', '{"limits":{"session":{"models":{}}}}'])
            assertThrows(() => parseUsage(bad), SchemaError, bad);
    });

    it('a model name is sanitized', () => {
        const s = parseUsage('{"limits":{"session":{"models":[{"name":"bad\\u001b[31m","request_count":1}]}}}');
        assertEqual(s.session.models[0].name, 'bad[31m');
    });
});

describe('placeholders', () => {
    it('oll_* keys and the cross-vendor aliases', () => {
        const m = placeholders(parseUsage(LIVE, 'Pro'), NOW);
        assertEqual(m.get('vendor_short'), VENDOR_SHORT);
        assertEqual(m.get('oll_session_pct'), '82');
        assertEqual(m.get('oll_weekly_pct'), '23');
        assertEqual(m.get('oll_monthly_pct'), '');
        assertEqual(m.get('oll_plan'), 'Pro');
        assertEqual(m.get('oll_cost'), '0.00000');
        assertEqual(m.get('oll_session_reset'), '—');
        assertEqual(m.get('oll_session_elapsed'), '0');
        assertEqual(m.get('session_pct'), '82');
        assertEqual(m.get('weekly_pct'), '23');
        assertEqual(m.get('session_reset'), '—');
        assertEqual(m.get('weekly_elapsed'), '0');
        assertEqual(m.get('plan'), 'Pro');
    });

    it('an absent window is empty; no plan reads Ollama; no cost is —', () => {
        const m = placeholders(parseUsage(MONTHLY), NOW);
        assertEqual(m.get('session_pct'), '');
        assertEqual(m.get('oll_monthly_pct'), '40');
        assertEqual(m.get('plan'), 'Ollama');
        assertEqual(m.get('oll_cost'), '—');
    });

    it('the default bar format renders', () => {
        assertEqual(substitute('{vendor_short} {oll_session_pct}%', placeholders(parseUsage(LIVE), NOW)), 'oll 82%');
    });
});

describe('peak, severity, notifications', () => {
    it('peak is the highest window, with no reset', () => {
        assertDeepEqual(ollamaPeakUsage(parseUsage(LIVE)), {percent: 82, resetsAt: null});
        assertEqual(ollamaPeakUsage(parseUsage('{}')).percent, 0);
    });

    it('severity follows the peak', () => {
        assertEqual(ollamaSeverity(parseUsage(LIVE)), Severity.HIGH);
    });

    it('one notify row per window present; no reset credits', () => {
        const rows = notifyRows(parseUsage(LIVE), t => `<${t}>`);
        assertEqual(rows.map(r => r.key).join(','), 'session,weekly');
        assertEqual(rows[0].label, '<Session>');
        assertEqual(rows[0].resetsAt, null);
        assertEqual(resetCredits(parseUsage(LIVE)).length, 0);
    });
});

describe('cache + fake', () => {
    it('round-trips the projected snapshot', () => {
        const s = parseUsage(LIVE, 'Pro');
        assertDeepEqual(parseCacheJson(snapshotToCacheJson(s)), s);
    });

    it('fakeSnapshot is unpaced and carries a breakdown', () => {
        const f = fakeSnapshot(90, NOW);
        assertEqual(f.session.utilizationPct, 90);
        assertEqual(f.session.resetsAt, null);
        assertEqual(f.weekly.models.length, 5);
    });
});

system.exit(summary());
