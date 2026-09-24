import {withMutex, staleResult} from '../fetch-common.js';
import {parseUsage} from './parser.js';

export const API_URL = 'https://api.sourcecraft.tech';
export const CACHE_TTL_MS = 60_000;

export function quotaUrl(organization) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(organization))
        throw new Error('SourceCraft: set a valid organization slug in preferences');
    return `${API_URL}/orgs/${encodeURIComponent(organization)}/quotas`;
}

async function doFetch({cache, http, apiKey, organization, signal}) {
    const url = quotaUrl(organization);
    const parse = bytes => parseUsage(bytes, organization);
    const staleOr = result => staleResult(cache, parse, result);
    const fresh = await cache.freshPayload(CACHE_TTL_MS);
    if (fresh !== null) {
        try {
            return {
                ok: true, snapshot: parse(fresh), stale: false,
                lastError: null, cacheAgeMs: await cache.payloadAgeMs() ?? 0,
            };
        } catch (_) { /* Fetch again when the cache is corrupt. */ }
    }
    const res = await http({
        method: 'GET', url,
        headers: {Authorization: `Bearer ${apiKey}`, Accept: 'application/json'},
        timeoutMs: 10_000, cancellable: signal,
    });
    let message;
    if (res.error) {
        message = 'SourceCraft: quota request failed (network error)';
    } else if (res.status >= 200 && res.status < 300) {
        try {
            const snapshot = parse(res.bodyBytes);
            cache.writePayload(res.bodyBytes);
            return {ok: true, snapshot, stale: false, lastError: null, cacheAgeMs: 0};
        } catch (_) {
            message = 'SourceCraft: invalid quota response';
        }
    } else {
        message = `SourceCraft: quota request failed (HTTP ${res.status})`;
    }
    cache.markStale();
    cache.writeLastError(res.status ?? 0, message);
    return staleOr({ok: false, kind: 'error', message});
}

export async function fetchSnapshot(deps) {
    try {
        return await withMutex(deps.cache.dir, () => doFetch(deps));
    } catch (_) {
        return {ok: false, kind: 'error', message: 'SourceCraft: unable to fetch quotas; check organization, token and cache access'};
    }
}
