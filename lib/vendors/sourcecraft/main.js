import {withMutex, staleResult, underBackoff, backoffResult, recordHttpError} from '../fetch-common.js';
import {parseUsage, snapshotToCacheJson, parseCacheJson} from './parser.js';

export const API_URL = 'https://api.sourcecraft.tech';
export const CACHE_TTL_MS = 60_000;
const HTTP_TIMEOUT_MS = 10_000;

export function quotaUrl(organization) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(organization))
        throw new Error('SourceCraft: set a valid organization slug in preferences');
    return `${API_URL}/orgs/${encodeURIComponent(organization)}/quotas`;
}

async function doFetch(deps) {
    const {cache, http, apiKey, organization, signal} = deps;
    const url = quotaUrl(organization);
    const now = deps.now ?? new Date();
    // The organization is a pref, so a cached snapshot shows the current one.
    const parseCached = bytes => ({...parseCacheJson(bytes), organization});
    const staleOr = original => staleResult(cache, parseCached, original);

    const fresh = await cache.freshPayload(CACHE_TTL_MS);
    if (fresh !== null) {
        try {
            return {
                ok: true,
                snapshot: parseCached(fresh),
                stale: false,
                lastError: null,
                cacheAgeMs: await cache.payloadAgeMs() ?? 0,
            };
        } catch (_) {
            // Corrupt fresh cache — fall through to a live fetch.
        }
    }

    const backoffUntil = await underBackoff(cache, now);
    if (backoffUntil !== null)
        return backoffResult(cache, parseCached, backoffUntil, now);

    const res = await http({
        method: 'GET',
        url,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
        },
        timeoutMs: HTTP_TIMEOUT_MS,
        cancellable: signal,
    });

    if (res.error)
        return staleOr({ok: false, kind: 'loading'});

    const status = res.status;
    if (status >= 200 && status < 300) {
        let snapshot;
        try {
            snapshot = parseUsage(res.bodyBytes, organization);
        } catch (e) {
            const msg = e?.message ?? String(e);
            cache.markStale();
            cache.writeLastError(0, msg);
            return staleOr({ok: false, kind: 'error', message: msg});
        }
        cache.writePayload(snapshotToCacheJson(snapshot));
        return {ok: true, snapshot, stale: false, lastError: null, cacheAgeMs: 0};
    }

    const body = new TextDecoder().decode(res.bodyBytes ?? new Uint8Array(0));
    cache.markStale();
    return staleOr(recordHttpError(cache, status, body, `SourceCraft: quota request failed (HTTP ${status})`));
}

export async function fetchSnapshot(deps) {
    return withMutex(deps?.cache?.dir ?? 'sourcecraft', () => doFetch(deps));
}
