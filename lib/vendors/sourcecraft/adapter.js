import GLib from 'gi://GLib';

import {Cache} from '../../cache.js';
import {resolveApiKey} from '../../config-resolve.js';
import {fetchSnapshot, quotaUrl} from './main.js';
import {
    ICON,
    VENDOR_SHORT,
    placeholders,
    severity,
    peakUsage,
    notifyRows,
    resetCredits,
    fakeSnapshot,
} from './parser.js';
import {buildSection} from './section.js';

export const sourcecraftAdapter = {
    id: 'sourcecraft',
    cacheId: 'sourcecraft',
    icon: ICON,
    vendorShort: VENDOR_SHORT,
    async fetchSnapshot(ctx) {
        try {
            const cfg = ctx.config.vendors.sourcecraft;
            quotaUrl(cfg.organization);
            const apiKey = resolveApiKey('SourceCraft', cfg.apiKeyEnv, cfg.apiKey, GLib.getenv);
            // Separate cached usage when the organization or authenticated user changes.
            const scope = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,
                JSON.stringify([cfg.organization, apiKey]), -1);
            return await fetchSnapshot({
                cache: Cache.forVendor(`sourcecraft-${scope}`),
                http: ctx.http, apiKey, organization: cfg.organization, signal: ctx.signal,
            });
        } catch (e) {
            return {ok: false, kind: 'error', message: e?.message ?? String(e)};
        }
    },
    severity,
    peakUsage,
    placeholders,
    notifyRows,
    resetCredits,
    buildSection,
    fakeSnapshot,
};
