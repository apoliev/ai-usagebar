import system from 'system';

import {parseUsage} from '../../../../lib/vendors/sourcecraft/parser.js';
import {buildSection} from '../../../../lib/vendors/sourcecraft/section.js';
import {defaultTheme} from '../../../../lib/theme.js';
import {describe, it, assertEqual, summary} from '../../../_assert.js';

const meta = {stale: false, lastError: null, cacheAgeMs: 0};
const build = (quotas, translate) => buildSection(
    parseUsage(JSON.stringify({quotas}), 'example'), meta, new Date(), defaultTheme(), translate);

describe('SourceCraft section', () => {
    it('renders quota counts and translated labels without a guessed reset', () => {
        const section = build([{quota_id: 'src.cuPrepaidRaw.count', usage: 25, limit: 100}], s => `translated:${s}`);
        assertEqual(section.rows[0].text, 'example');
        const gauge = section.rows.find(row => row.kind === 'gauge');
        assertEqual(gauge.title, 'translated:Monthly AI quota');
        assertEqual(gauge.value, '25 / 100');
        assertEqual(gauge.pct, 25);
        assertEqual(gauge.reset, undefined);
    });
    it('renders the personal subscription quota as the first gauge', () => {
        const section = build([
            {quota_id: 'src.completionRequests.count', usage: 21, limit: 4000},
            {quota_id: 'src.cu.count', usage: 1000, limit: 4000},
        ], s => `t:${s}`);
        const gauges = section.rows.filter(row => row.kind === 'gauge');
        assertEqual(gauges.length, 2);
        assertEqual(gauges[0].title, 't:Subscription neurocredits');
        assertEqual(gauges[0].pct, 25);
        assertEqual(gauges[1].title, 't:Code completions');
    });
    it('does not draw a misleading gauge for a zero limit', () => {
        const section = build([{quota_id: 'src.cuFlexible.count', usage: 0, limit: 0}]);
        assertEqual(section.rows.some(row => row.kind === 'gauge'), false);
        assertEqual(section.rows[1].text, 'Extra neurocredits: 0 / 0');
    });
    it('explains missing quotas', () => {
        assertEqual(build([]).rows[1].text, 'No Code Assistant quotas reported for this organization');
    });
});

system.exit(summary());
