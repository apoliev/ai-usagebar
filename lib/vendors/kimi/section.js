import {calc} from '../../pacing.js';
import {format as formatCountdown, formatWithClock} from '../../countdown.js';
import {vformat} from '../../format.js';
import {httpErrorRow, footerRow, paceFields} from '../section-common.js';
import {pct, WEEKLY_MS, WINDOW_MS} from './parser.js';

const ICON_WEEKLY = 'x-office-calendar-symbolic';
const ICON_WINDOW = 'alarm-symbolic';

// `windowMs` null → no pace: the monthly pool resets from the order date, so
// there is no fixed window length to pace against.
function windowRow(icon, title, utilizationPct, resetAt, windowMs, now, theme, _) {
    const pace = windowMs === null ? null : calc({usagePct: utilizationPct, reset: resetAt, now, windowMs});
    return {
        kind: 'window',
        icon,
        title,
        pct: utilizationPct,
        reset: formatCountdown(resetAt, now, _),
        subtitle: formatWithClock(resetAt, now, _),
        ...paceFields(utilizationPct, pace, theme, _, {footnote: false}),
    };
}

function blockRow(icon, title, block, windowMs, now, theme, _) {
    return windowRow(icon, title, pct(block.used, block.limit), block.resetAt, windowMs, now, theme, _);
}

export function buildSection(snapshot, meta, now, theme, _ = (s) => s) {
    const rows = [];

    if (snapshot.window.limit > 0)
        rows.push(blockRow(ICON_WINDOW, _('Window (5h)'), snapshot.window, WINDOW_MS, now, theme, _));
    if (snapshot.weekly)
        rows.push(blockRow(ICON_WEEKLY, _('Weekly'), snapshot.weekly, WEEKLY_MS, now, theme, _));
    if (snapshot.monthly) {
        rows.push(windowRow(ICON_WEEKLY, _('Monthly'), snapshot.monthly.utilizationPct,
            snapshot.monthly.resetsAt, null, now, theme, _));
    }

    const err = httpErrorRow(meta, theme, _);
    if (err)
        rows.push(err);

    rows.push(footerRow(meta, _));

    // Translators: "Kimi" is a brand name — kept verbatim.
    const title = snapshot.plan ? vformat(_('Kimi %s'), snapshot.plan) : 'Kimi';
    return {title, plan: snapshot.plan, rows};
}
