import {vformat, formatMoney} from '../../format.js';
import {httpErrorRow, footerRow, groupHeading, groupedUsage, paceFields} from '../section-common.js';
import {planLabel} from './parser.js';

const ICON_SESSION = 'alarm-symbolic';
const ICON_WEEKLY = 'x-office-calendar-symbolic';
const ICON_COST = 'utilities-system-monitor-symbolic';

const pluralEn = (singular, plural, n) => (n === 1 ? singular : plural);

// No reset instant is reported, so a window is never paced.
function windowRow(icon, title, win, theme, _) {
    return {
        kind: 'window',
        icon,
        title,
        pct: win.utilizationPct,
        reset: '',
        subtitle: '',
        ...paceFields(win.utilizationPct, null, theme, _),
    };
}

// Each model's share of the window's requests; the fill stays muted because
// a share is not a quota.
function breakdownRows(group, win, theme, _, ngettext) {
    if (win.models.length === 0)
        return [];
    const rows = [groupHeading(_('Breakdown'))];
    for (const model of win.models) {
        const n = model.requestCount;
        rows.push(groupedUsage({
            group,
            label: model.name,
            percent: win.totalRequests > 0 ? Math.round((n * 100) / win.totalRequests) : 0,
            valueText: vformat(ngettext('%d request', '%d requests', n), n),
            severity: null,
        }, theme));
    }
    return rows;
}

function costText(cost) {
    const n = Number(cost.trim());
    return cost.trim() !== '' && Number.isFinite(n) ? formatMoney(n) : cost;
}

export function buildSection(snapshot, meta, now, theme, _ = (s) => s, ngettext = pluralEn) {
    const rows = [];
    const windows = [
        ['session', ICON_SESSION, _('Session')],
        ['weekly', ICON_WEEKLY, _('Weekly')],
        ['monthly', ICON_WEEKLY, _('Monthly')],
    ];
    for (const [key, icon, title] of windows) {
        const win = snapshot[key];
        if (!win)
            continue;
        rows.push(windowRow(icon, title, win, theme, _));
        rows.push(...breakdownRows(key, win, theme, _, ngettext));
    }
    if (rows.length === 0)
        rows.push({kind: 'text', text: _('no usage windows reported'), tone: 'dim'});

    if (snapshot.cost !== null) {
        rows.push({kind: 'text', icon: ICON_COST, text: _('Cost'), tone: 'fg'});
        rows.push({kind: 'text', text: costText(snapshot.cost), tone: 'dim'});
    }

    const err = httpErrorRow(meta, theme, _);
    if (err)
        rows.push(err);

    rows.push(footerRow(meta, _));

    // Translators: %s is the Ollama plan name from the prefs (e.g. "Pro") — kept verbatim.
    const title = snapshot.plan ? vformat(_('Ollama %s'), snapshot.plan) : planLabel(snapshot);
    return {title, plan: planLabel(snapshot), rows};
}
