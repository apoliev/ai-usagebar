import system from 'system';

import {buildSection} from '../../../../lib/vendors/ollama/section.js';
import {parseUsage} from '../../../../lib/vendors/ollama/parser.js';
import {defaultTheme} from '../../../../lib/theme.js';
import {describe, it, assertEqual, assertDeepEqual, summary} from '../../../_assert.js';

const theme = defaultTheme();
const NOW = new Date('2026-09-09T18:30:00Z');
const META = {stale: false, lastError: null, fetchedAt: NOW};

const models = n => Array.from({length: n}, (_, i) => ({name: `m${i}`, request_count: (n - i) * 10}));
const body = limits => JSON.stringify({limits, activity: {cost: '1.5'}});

describe('buildSection (ollama)', () => {
    const snap = parseUsage(body({session: {usage: 0.5, models: models(7)}, weekly: {usage: 0.2, models: []}}), 'Pro');
    const model = buildSection(snap, META, NOW, theme);
    const rows = model.rows;

    it('titles with the plan', () => {
        assertEqual(model.title, 'Ollama Pro');
        assertEqual(buildSection(parseUsage(body({})), META, NOW, theme).title, 'Ollama');
    });

    it('a window row per window, never paced', () => {
        const windows = rows.filter(r => r.kind === 'window');
        assertEqual(windows.length, 2);
        for (const w of windows) {
            assertEqual(w.paceGlyph, '');
            assertEqual('elapsedPct' in w, false);
            assertEqual('paceFootnote' in w, false);
        }
    });

    it('the breakdown follows its window: heading + top 5 grouped rows', () => {
        assertEqual(rows[0].kind, 'window');
        assertDeepEqual(rows[1], {kind: 'group-heading', label: 'Breakdown'});
        const grouped = rows.filter(r => r.kind === 'grouped');
        assertEqual(grouped.length, 5);
        assertEqual(grouped[0].label, 'm0');
        assertEqual(grouped[0].valueText, '70 requests');
        assertEqual(grouped[0].severity, null);
        assertEqual(grouped[0].color, theme.dim);
    });

    it('a share is of every request in the window, not just the top 5', () => {
        // 7 models: 70+60+…+10 = 280 requests; m0 has 70 → 25%.
        assertEqual(rows.find(r => r.kind === 'grouped').pct, 25);
    });

    it('keys are stable per window and model', () => {
        const again = buildSection(snap, META, NOW, theme).rows.filter(r => r.kind === 'grouped');
        assertEqual(again[0].key, rows.find(r => r.kind === 'grouped').key);
    });

    it('a window without models has no breakdown', () => {
        const weekly = rows.findIndex(r => r.kind === 'window' && r.title === 'Weekly');
        assertEqual(rows[weekly + 1].kind === 'group-heading', false);
    });

    it('a numeric cost is money; anything else stays raw', () => {
        assertEqual(rows.some(r => r.text === '$1.50'), true);
        const raw = buildSection(parseUsage(JSON.stringify({activity: {cost: 'n/a'}})), META, NOW, theme).rows;
        assertEqual(raw.some(r => r.text === 'n/a'), true);
    });

    it('no windows → a dim note', () => {
        const empty = buildSection(parseUsage('{}'), META, NOW, theme).rows;
        assertEqual(empty[0].text, 'no usage windows reported');
    });

    it('one request is singular, through the injected ngettext', () => {
        const one = parseUsage(body({session: {usage: 0.1, models: [{name: 'x', request_count: 1}]}}));
        const ngettext = (s, p, n) => (n === 1 ? `<${s}>` : `<${p}>`);
        const r = buildSection(one, META, NOW, theme, s => s, ngettext).rows.find(row => row.kind === 'grouped');
        assertEqual(r.valueText, '<1 request>');
        assertEqual(r.pct, 100);
    });
});

system.exit(summary());
