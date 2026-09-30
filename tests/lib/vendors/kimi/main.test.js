import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

import {Cache} from '../../../../lib/cache.js';
import {parseUsage, snapshotToCacheJson} from '../../../../lib/vendors/kimi/parser.js';
import {fetchSnapshot, USAGES_URL, ME_URL} from '../../../../lib/vendors/kimi/main.js';
import {describe, it, assertEqual, summary} from '../../../_assert.js';

const LIVE = JSON.stringify({
    user: {membership: {level: 'LEVEL_PRO'}},
    usage: {limit: '100', used: '42', remaining: '58', resetTime: '2026-02-11T17:32:50Z'},
    limits: [
        {
            window: {duration: 300, timeUnit: 'TIME_UNIT_MINUTE'},
            detail: {limit: '100', used: '15', remaining: '85'},
        },
    ],
});
const SEED = JSON.stringify({usage: {limit: '100', used: '10', remaining: '90'}});

const cached = (raw) => snapshotToCacheJson(parseUsage(raw));

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
// Dispatches by URL so the concurrent /usages + /me pair is order-independent.
function routeStub(routes) {
    const calls = [];
    const fn = (opts) => {
        calls.push(opts);
        const r = routes[opts.url];
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
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
        const dir = GLib.Dir.make_tmp('ai-usagebar-kimi-XXXXXX');
        const prev = GLib.getenv('XDG_CACHE_HOME');
        GLib.setenv('XDG_CACHE_HOME', dir, true);
        try {
            fn({cache: Cache.forVendor('kimi'), dir});
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

describe('fetchSnapshot (kimi)', () => {
    it('live 200 parses the shape and sends Bearer + Accept headers', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'sk-test'}));
        assertEqual(http.calls[0].url, USAGES_URL);
        assertEqual(http.calls[0].headers.Authorization, 'Bearer sk-test');
        assertEqual(http.calls[0].headers.Accept, 'application/json');
        assertEqual(r.ok, true);
        assertEqual(r.snapshot.plan, 'Pro'); // /me stub returns the same body → no tier name
        assertEqual(r.snapshot.weekly.used, 42);
        assertEqual(r.snapshot.window.used, 15);
    }));

    it('/me runs alongside /usages and its tier name is the plan, kept through the cache', withTemp(({cache}) => {
        const http = routeStub({
            [USAGES_URL]: res(200, LIVE),
            [ME_URL]: res(200, JSON.stringify({email: 'x@example.com', user_level_name: 'Allegretto'})),
        });
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'sk-test'}));
        assertEqual(http.calls.length, 2);
        const me = http.calls.find(c => c.url === ME_URL);
        assertEqual(me.headers.Authorization, 'Bearer sk-test');
        assertEqual(me.headers.Accept, 'application/json');
        assertEqual(r.snapshot.plan, 'Allegretto');

        const cached = runSync(fetchSnapshot({cache, http: routeStub({}), apiKey: 'sk-test'}));
        assertEqual(cached.ok, true);
        assertEqual(cached.snapshot.plan, 'Allegretto');
    }));

    it('a failing /me falls back to the humanized level and keeps ok', withTemp(({cache}) => {
        for (const me of [res(404, '{"error":"no coding profile"}'), new Error('boom'),
            {status: 0, headers: {}, bodyBytes: new Uint8Array(0), error: {kind: 'transport', message: 'down'}}]) {
            const http = routeStub({[USAGES_URL]: res(200, LIVE), [ME_URL]: me});
            const r = runSync(fetchSnapshot({cache, http, apiKey: 'k', cacheTtlMs: 0}));
            assertEqual(r.ok, true);
            assertEqual(r.snapshot.plan, 'Pro');
            assertEqual(r.snapshot.weekly.used, 42);
        }
    }));

    it('HTTP 401 falls back to stale cache with lastError.code 401', withTemp(({cache}) => {
        cache.writePayload(cached(SEED));
        backdate(cache, 120);
        const http = httpStub(res(401, '{"secret":"do-not-leak"}'));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k'}));
        assertEqual(r.ok, true);
        assertEqual(r.stale, true);
        assertEqual(r.snapshot.weekly.used, 10);
        assertEqual(r.lastError.code, 401);
        // The persisted diagnostic never echoes the upstream body.
        assertEqual(r.lastError.body, '');
    }));

    it('HTTP 401 with no cache → auth-rejected, body never echoed', withTemp(({cache}) => {
        const http = httpStub(res(401, '{"secret":"do-not-leak"}'));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k'}));
        assertEqual(r.ok, false);
        assertEqual(r.kind, 'error');
        assertEqual(r.code, 'auth-rejected');
        assertEqual(r.status, 401);
        assertEqual(JSON.stringify(r).includes('do-not-leak'), false);
    }));

    it('HTTP 500 with no cache → kind:error mentioning the status', withTemp(({cache}) => {
        const http = httpStub(res(500, 'upstream boom'));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k'}));
        assertEqual(r.ok, false);
        assertEqual(r.kind, 'error');
        assertEqual(r.message.includes('500'), true);
        assertEqual(r.message.includes('boom'), false); // body never echoed
    }));

    it('transient failure with no cache → kind:loading (never error)', withTemp(({cache}) => {
        const http = httpStub({status: 0, headers: {}, bodyBytes: new Uint8Array(0), error: new Error('network down')});
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k'}));
        assertEqual(r.ok, false);
        assertEqual(r.kind, 'loading');
    }));

    it('schema drift (2xx unparseable) with no cache → error, body not cached', withTemp(({cache}) => {
        const http = httpStub(res(200, 'not json'));
        const r = runSync(fetchSnapshot({cache, http, apiKey: 'k'}));
        assertEqual(r.ok, false);
        assertEqual(r.kind, 'error');
        assertEqual(runSync(cache.maybePayload()), null);
    }));
});

system.exit(summary());
