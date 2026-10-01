import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

import {Cache} from '../../../../lib/cache.js';
import {parseUsage, snapshotToCacheJson} from '../../../../lib/vendors/sourcecraft/parser.js';
import {fetchSnapshot, quotaUrl, API_URL} from '../../../../lib/vendors/sourcecraft/main.js';
import {describe, it, assertEqual, assertDeepEqual, assertThrows, summary} from '../../../_assert.js';

const LIVE = JSON.stringify({quotas: [
    {quota_id: 'src.cuPrepaidRaw.count', usage: 25, limit: 100},
]});
const PERSONAL_LIVE = JSON.stringify({quotas: [
    {quota_id: 'src.cu.count', usage: 1000, limit: 4000},
]});
const ORG_LIVE = JSON.stringify({quotas: [
    {quota_id: 'src.cuPrepaidRaw.count', usage: 0, limit: 4000},
    {quota_id: 'src.cuFlexible.count', usage: 0, limit: 0},
    {quota_id: 'src.completionRequests.count', usage: 21, limit: 4000},
]});
const SEED = JSON.stringify({quotas: [
    {quota_id: 'src.cuPrepaidRaw.count', usage: 5, limit: 100},
]});
const cached = raw => snapshotToCacheJson(parseUsage(raw));

function runSync(promise) {
    const loop = GLib.MainLoop.new(null, false);
    let value, err, done = false;
    Promise.resolve(promise).then(
        v => { value = v; done = true; loop.quit(); },
        e => { err = e; done = true; loop.quit(); }
    );
    if (!done)
        loop.run();
    if (err)
        throw err;
    return value;
}

function httpStub(response) {
    const calls = [];
    const fn = (opts) => {
        calls.push(opts);
        return Promise.resolve(response);
    };
    fn.calls = calls;
    return fn;
}

function httpRoute(map) {
    const calls = [];
    const fn = (opts) => {
        calls.push(opts);
        const hit = Object.entries(map).find(([needle]) => opts.url.includes(needle));
        return Promise.resolve(hit ? hit[1] : res(404, 'unrouted'));
    };
    fn.calls = calls;
    return fn;
}
function res(status, text) {
    return {status, headers: {}, bodyBytes: new TextEncoder().encode(text ?? ''), error: null};
}

function rmRf(path) {
    const f = Gio.File.new_for_path(path);
    if (!f.query_exists(null))
        return;
    let info;
    try {
        info = f.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch (_) { return; }
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const en = f.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let child;
        while ((child = en.next_file(null)))
            rmRf(GLib.build_filenamev([path, child.get_name()]));
        en.close(null);
    }
    try { f.delete(null); } catch (_) { /* best-effort */ }
}

function withTemp(fn) {
    return () => {
        const dir = GLib.Dir.make_tmp('ai-usagebar-sourcecraft-XXXXXX');
        const prev = GLib.getenv('XDG_CACHE_HOME');
        GLib.setenv('XDG_CACHE_HOME', dir, true);
        try {
            fn({cache: Cache.forVendor('sourcecraft'), dir});
        } finally {
            if (prev !== null && prev !== undefined)
                GLib.setenv('XDG_CACHE_HOME', prev, true);
            else
                GLib.unsetenv('XDG_CACHE_HOME');
            rmRf(dir);
        }
    };
}

function backdate(cache, secs) {
    const f = Gio.File.new_for_path(cache.payloadPath);
    f.set_attribute_uint64('time::modified', Math.floor(Date.now() / 1000) - secs, Gio.FileQueryInfoFlags.NONE, null);
    f.set_attribute_uint32('time::modified-usec', 0, Gio.FileQueryInfoFlags.NONE, null);
}

describe('fetchSnapshot (sourcecraft)', () => {
    it('live 200 hits both endpoints with Bearer + Accept, parses and merges', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'example'}));
        assertEqual(http.calls.length, 2);
        assertDeepEqual(http.calls.map(c => c.url), [
            `${API_URL}/orgs/example/personal-quotas/me`,
            `${API_URL}/orgs/example/quotas`,
        ]);
        for (const call of http.calls) {
            assertEqual(call.headers.Authorization, 'Bearer k');
            assertEqual(call.headers.Accept, 'application/json');
            assertEqual(call.cancellable, undefined);
        }
        assertEqual(r.ok, true);
        assertEqual(r.stale, false);
        assertEqual(r.snapshot.quotas[0].percent, 25);
        assertEqual(r.snapshot.organization, 'example');
    }));

    it('merges the personal subscription with org buckets and retires prepaid', withTemp(({cache}) => {
        const http = httpRoute({
            'personal-quotas': res(200, PERSONAL_LIVE),
            '/quotas': res(200, ORG_LIVE),
        });
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'example'}));
        assertEqual(r.ok, true);
        assertDeepEqual(r.snapshot.quotas.map(q => q.kind), ['subscription', 'extra', 'completions']);
        assertEqual(r.snapshot.quotas[0].percent, 25);
    }));

    it('a personal failure degrades to the org answer', withTemp(({cache}) => {
        const http = httpRoute({
            'personal-quotas': res(404, 'gone'),
            '/quotas': res(200, ORG_LIVE),
        });
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'example'}));
        assertEqual(r.ok, true);
        assertDeepEqual(r.snapshot.quotas.map(q => q.kind), ['monthly', 'extra', 'completions']);
    }));

    it('an org failure degrades to the personal answer', withTemp(({cache}) => {
        const http = httpRoute({
            'personal-quotas': res(200, PERSONAL_LIVE),
            '/quotas': res(500, 'boom'),
        });
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'example'}));
        assertEqual(r.ok, true);
        assertDeepEqual(r.snapshot.quotas.map(q => q.kind), ['subscription']);
    }));

    it('a 429 on one endpoint serves the other and still arms the backoff', withTemp(({cache}) => {
        const http = httpRoute({
            'personal-quotas': res(429, 'slow down'),
            '/quotas': res(200, ORG_LIVE),
        });
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'example'}));
        assertEqual(r.ok, true);
        assertEqual(r.stale, false);
        assertDeepEqual(r.snapshot.quotas.map(q => q.kind), ['monthly', 'extra', 'completions']);
        backdate(cache, 120);
        const http2 = httpStub(res(200, ORG_LIVE));
        const r2 = runSync(fetchSnapshot({cache, http: http2, apiKey: 'k', organization: 'example'}));
        assertEqual(http2.calls.length, 0);
        assertEqual(r2.ok, true);
        assertEqual(r2.stale, true);
    }));

    it('the cache holds only the projected snapshot, never the raw body', withTemp(({cache}) => {
        const body = JSON.stringify({request_id: 'sensitive-request-id', quotas: JSON.parse(LIVE).quotas});
        runSync(fetchSnapshot({cache, http: httpStub(res(200, body)), apiKey: 'k', organization: 'example'}));
        const onDisk = new TextDecoder().decode(runSync(cache.maybePayload()));
        assertEqual(onDisk.includes('sensitive-request-id'), false);
        assertEqual(onDisk.includes('cacheVersion'), true);
    }));

    it('a fresh cache skips the network and shows the current organization pref', withTemp(({cache}) => {
        cache.writePayload(cached(SEED));
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'other-org'}));
        assertEqual(http.calls.length, 0);
        assertEqual(r.snapshot.quotas[0].percent, 5);
        assertEqual(r.snapshot.organization, 'other-org');
    }));

    it('a raw body cached by an older release is refetched, not served', withTemp(({cache}) => {
        cache.writePayload(SEED);
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'example'}));
        assertEqual(http.calls.length, 2);
        assertEqual(r.ok, true);
        assertEqual(r.snapshot.quotas[0].percent, 25);
    }));

    for (const status of [401, 403, 500]) {
        it(`HTTP ${status} with a cache → stale, the body is redacted on disk`, withTemp(({cache}) => {
            cache.writePayload(cached(SEED));
            backdate(cache, 120);
            const r = runSync(fetchSnapshot({cache, http: httpStub(res(status, 'sensitive response')), apiKey: 'k', organization: 'example'}));
            assertEqual(r.ok, true);
            assertEqual(r.stale, true);
            assertEqual(r.lastError.code, status);
            if (status === 401 || status === 403)
                assertEqual(r.lastError.body, '');
            const onDisk = new TextDecoder().decode(runSync(cache.maybePayload()));
            assertEqual(onDisk.includes('sensitive'), false);
        }));
    }

    it('after a 429 the next poll makes no request', withTemp(({cache}) => {
        cache.writePayload(cached(SEED));
        backdate(cache, 120);
        const first = runSync(fetchSnapshot({cache, http: httpStub(res(429, 'slow down')), apiKey: 'k', organization: 'example'}));
        assertEqual(first.stale, true);
        assertEqual(first.lastError.code, 429);
        const http = httpStub(res(200, LIVE));
        const second = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'example'}));
        assertEqual(http.calls.length, 0);
        assertEqual(second.ok, true);
        assertEqual(second.stale, true);
    }));

    it('a 429 with no cache → rate-limited error, then still no request', withTemp(({cache}) => {
        runSync(fetchSnapshot({cache, http: httpStub(res(429, '')), apiKey: 'k', organization: 'example'}));
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'example'}));
        assertEqual(http.calls.length, 0);
        assertEqual(r.ok, false);
        assertEqual(r.code, 'rate-limited');
    }));

    it('transient failure with a cache → stale; with no cache → loading', withTemp(({cache}) => {
        const offline = {status: 0, headers: {}, bodyBytes: new Uint8Array(0), error: {kind: 'transport', message: 'refused'}};
        cache.writePayload(cached(SEED));
        backdate(cache, 120);
        const stale = runSync(fetchSnapshot({cache, http: httpStub(offline), apiKey: 'k', organization: 'example'}));
        assertEqual(stale.ok, true);
        assertEqual(stale.stale, true);
        const empty = Cache.forVendor('sourcecraft-empty');
        const r = runSync(fetchSnapshot({cache: empty, http: httpStub(offline), apiKey: 'k', organization: 'example'}));
        assertEqual(r.ok, false);
        assertEqual(r.kind, 'loading');
    }));

    it('schema drift with no cache → error, nothing cached', withTemp(({cache}) => {
        const r = runSync(fetchSnapshot({cache, http: httpStub(res(200, '{"message":"oops"}')), apiKey: 'k', organization: 'example'}));
        assertEqual(r.ok, false);
        assertEqual(r.kind, 'error');
        assertEqual(runSync(cache.maybePayload()), null);
    }));

    it('a dependency failure rejects; the adapter turns it into an error result', withTemp(({cache}) => {
        cache.freshPayload = async () => { throw new Error('unreadable'); };
        let err = null;
        try {
            runSync(fetchSnapshot({cache, http: httpStub(res(200, LIVE)), apiKey: 'k', organization: 'example'}));
        } catch (e) {
            err = e;
        }
        assertEqual(err?.message, 'unreadable');
    }));

    it('rejects missing or path-like organization slugs before a request', () => {
        for (const slug of ['', '../foo', 'foo/bar', 'foo?x=1'])
            assertThrows(() => quotaUrl(slug));
    });
});

system.exit(summary());
