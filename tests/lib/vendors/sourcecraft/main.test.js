import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

import {Cache} from '../../../../lib/cache.js';
import {parseUsage, snapshotToCacheJson} from '../../../../lib/vendors/sourcecraft/parser.js';
import {fetchSnapshot, quotaUrl, API_URL} from '../../../../lib/vendors/sourcecraft/main.js';
import {describe, it, assertEqual, assertThrows, summary} from '../../../_assert.js';

const LIVE = JSON.stringify({quotas: [
    {quota_id: 'src.cuPrepaidRaw.count', usage: 25, limit: 100},
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
    it('live 200 sends Bearer + Accept, parses the body and validates the slug', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', organization: 'example'}));
        assertEqual(http.calls.length, 1);
        assertEqual(http.calls[0].url, `${API_URL}/orgs/example/quotas`);
        assertEqual(http.calls[0].headers.Authorization, 'Bearer k');
        assertEqual(http.calls[0].headers.Accept, 'application/json');
        assertEqual(http.calls[0].cancellable, undefined);
        assertEqual(r.ok, true);
        assertEqual(r.stale, false);
        assertEqual(r.snapshot.quotas[0].percent, 25);
        assertEqual(r.snapshot.organization, 'example');
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
        assertEqual(http.calls.length, 1);
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
