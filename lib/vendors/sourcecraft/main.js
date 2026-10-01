import {withMutex, staleResult, underBackoff, backoffResult, recordHttpError} from '../fetch-common.js';
import {parseUsage, mergeQuotas, snapshotToCacheJson, parseCacheJson} from './parser.js';

export const API_URL = 'https://api.sourcecraft.tech';
export const CACHE_TTL_MS = 60_000;
const HTTP_TIMEOUT_MS = 10_000;

function assertOrganization(organization) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(organization))
        throw new Error('SourceCraft: set a valid organization slug in preferences');
}

export function quotaUrl(organization) {
    assertOrganization(organization);
    return `${API_URL}/orgs/${encodeURIComponent(organization)}/quotas`;
}

export function personalQuotaUrl(organization) {
    assertOrganization(organization);
    return `${API_URL}/orgs/${encodeURIComponent(organization)}/personal-quotas/me`;
}

async function getQuotas(http, url, apiKey, signal) {
    return http({
        method: 'GET',
        url,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
        },
        timeoutMs: HTTP_TIMEOUT_MS,
        cancellable: signal,
    });
}

const decodeBody = res => new TextDecoder().decode(res.bodyBytes ?? new Uint8Array(0));

// One endpoint's outcome: a parsed snapshot, or a typed failure kept around
// for the error path (`transport`, an HTTP `status`, or a `schema` message).
function attemptOutcome(res) {
    if (res.error)
        return {ok: false, transport: true};
    if (res.status < 200 || res.status >= 300)
        return {ok: false, status: res.status, body: decodeBody(res)};
    try {
        return {ok: true, snapshot: parseUsage(res.bodyBytes)};
    } catch (e) {
        return {ok: false, schema: e?.message ?? String(e)};
    }
}

// Both endpoints unusable: keep the legacy single-endpoint semantics with the
// org answer as primary, falling back to the personal one only for a concrete
// HTTP status the org attempt lacks.
function bothFailed(cache, staleOr, org, personal) {
    const primary = org.status !== undefined || personal.status === undefined
        ? org : personal;
    if (primary.status !== undefined) {
        cache.markStale();
        return staleOr(recordHttpError(cache, primary.status, primary.body ?? '',
            `SourceCraft: quota request failed (HTTP ${primary.status})`));
    }
    if (primary.schema) {
        cache.markStale();
        cache.writeLastError(0, primary.schema);
        return staleOr({ok: false, kind: 'error', message: primary.schema});
    }
    return staleOr({ok: false, kind: 'loading'});
}

async function doFetch(deps) {
    const {cache, http, apiKey, organization, signal} = deps;
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

    const [personalRes, orgRes] = await Promise.all([
        getQuotas(http, personalQuotaUrl(organization), apiKey, signal),
        getQuotas(http, quotaUrl(organization), apiKey, signal),
    ]);
    const personal = attemptOutcome(personalRes);
    const org = attemptOutcome(orgRes);

    if (!personal.ok && !org.ok)
        return bothFailed(cache, staleOr, org, personal);

    const source = personal.ok ? personal.snapshot : org.snapshot;
    const snapshot = {
        plan: source.plan,
        organization,
        quotas: mergeQuotas(
            personal.ok ? personal.snapshot.quotas : [],
            org.ok ? org.snapshot.quotas : []
        ),
    };

    const limited = [personal, org].find(a => !a.ok && a.status === 429);
    cache.writePayload(snapshotToCacheJson(snapshot));
    // After writePayload, which clears the backoff the 429 must keep armed.
    if (limited)
        recordHttpError(cache, 429, limited.body, 'SourceCraft: quota request failed (HTTP 429)');
    return {ok: true, snapshot, stale: false, lastError: null, cacheAgeMs: 0};
}

export async function fetchSnapshot(deps) {
    return withMutex(deps?.cache?.dir ?? 'sourcecraft', () => doFetch(deps));
}
