import {severityFor, severityColor} from '../../severity.js';
import {vformat} from '../../format.js';
import {httpErrorRow, footerRow} from '../section-common.js';

export function buildSection(snapshot, meta, now, theme, _ = (s) => s) {
    const labels = {
        monthly: _('Monthly AI quota'),
        bonus: _('Bonus AI quota'),
        extra: _('Extra neurocredits'),
        completions: _('Code completions'),
    };
    const rows = [{kind: 'text', text: snapshot.organization, tone: 'dim'}];
    for (const q of snapshot.quotas) {
        if (q.percent === null) {
            rows.push({kind: 'text', text: `${labels[q.kind]}: ${q.usage} / ${q.limit}`, tone: 'dim'});
            continue;
        }
        rows.push({
            kind: 'gauge',
            icon: 'utilities-system-monitor-symbolic',
            title: labels[q.kind],
            pct: q.percent,
            value: `${q.usage} / ${q.limit}`,
            subLine: vformat(_('%s of %s used (%s%%)'), q.usage, q.limit, q.percent),
            color: severityColor(severityFor(q.percent), theme),
        });
    }
    if (!snapshot.quotas.length)
        rows.push({kind: 'text', text: _('No Code Assistant quotas reported for this organization'), tone: 'dim'});
    const err = httpErrorRow(meta, theme, _);
    if (err)
        rows.push(err);
    rows.push(footerRow(meta, _));
    return {title: snapshot.plan, plan: snapshot.plan, rows};
}
