import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

import {Cache} from '../../../../lib/cache.js';
import {parseUsage, snapshotToCacheJson, requestHeaders} from '../../../../lib/vendors/custom/parser.js';
import {fetchSnapshot} from '../../../../lib/vendors/custom/main.js';
import {customAdapter} from '../../../../lib/vendors/custom/adapter.js';
import {describe, it, assertEqual, summary} from '../../../_assert.js';

const URL = 'https://api.example.com/usage';
const MAPPING = {planPath: '/account/tier', metrics: [{label: 'Requests', used: '/usage/used', limit: '/usage/limit'}]};
const LIVE = JSON.stringify({account: {tier: 'Team', email: 'someone@example.com'}, usage: {used: 42, limit: 100}});
const SEED = JSON.stringify({account: {tier: 'Seed'}, usage: {used: 10, limit: 100}});
const HEADERS = requestHeaders({authHeader: 'Authorization', authScheme: 'Bearer', extraHeaders: {'X-Team': 'core'}}, 'k');
const cached = (raw) => snapshotToCacheJson({...parseUsage(raw, MAPPING), name: 'Team API'});

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
        const dir = GLib.Dir.make_tmp('ai-usagebar-custom-XXXXXX');
        const prev = GLib.getenv('XDG_CACHE_HOME');
        GLib.setenv('XDG_CACHE_HOME', dir, true);
        try {
            fn({cache: Cache.forVendor('custom'), dir});
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

function deps(cache, http, extra = {}) {
    return {cache, http, url: URL, allowHttp: false, headers: HEADERS, mapping: MAPPING, name: 'Team API', ...extra};
}

describe('fetchSnapshot (custom)', () => {
    it('live 200 GETs the URL with the configured headers and projects the mapping', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot(deps(cache, http)));
        assertEqual(http.calls.length, 1);
        assertEqual(http.calls[0].method, 'GET');
        assertEqual(http.calls[0].url, URL);
        assertEqual(http.calls[0].headers.Authorization, 'Bearer k');
        assertEqual(http.calls[0].headers['X-Team'], 'core');
        assertEqual(http.calls[0].headers.Accept, 'application/json');
        assertEqual(r.ok, true);
        assertEqual(r.snapshot.plan, 'Team');
        assertEqual(r.snapshot.metrics[0].pct, 42);
        assertEqual(r.snapshot.name, 'Team API');
    }));

    it('the cache holds only the projected snapshot', withTemp(({cache}) => {
        runSync(fetchSnapshot(deps(cache, httpStub(res(200, LIVE)))));
        const onDisk = new TextDecoder().decode(runSync(cache.maybePayload()));
        assertEqual(onDisk.includes('someone@example.com'), false);
    }));

    it('an http:// URL without allow-http → error, no request', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot(deps(cache, http, {url: 'http://localhost:8765/usage'})));
        assertEqual(http.calls.length, 0);
        assertEqual(r.ok, false);
        assertEqual(r.kind, 'error');
        assertEqual(r.message.includes('localhost'), false);
    }));

    it('an http:// URL with allow-http is fetched', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot(deps(cache, http, {url: 'http://localhost:8765/usage', allowHttp: true})));
        assertEqual(http.calls.length, 1);
        assertEqual(r.ok, true);
    }));

    it('a URL with user:pass@ → error, no request', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(fetchSnapshot(deps(cache, http, {url: 'https://me:pw@api.example.com/usage'})));
        assertEqual(http.calls.length, 0);
        assertEqual(r.ok, false);
        assertEqual(JSON.stringify(r).includes('pw'), false);
    }));

    it('a pointer that does not resolve → error, then stale over a cache', withTemp(({cache}) => {
        const r = runSync(fetchSnapshot(deps(cache, httpStub(res(200, '{"usage":{}}')))));
        assertEqual(r.ok, false);
        assertEqual(r.message.includes('/account/tier is missing'), true);
        cache.writePayload(cached(SEED));
        backdate(cache, 120);
        const stale = runSync(fetchSnapshot(deps(cache, httpStub(res(200, '{"usage":{}}')))));
        assertEqual(stale.ok, true);
        assertEqual(stale.stale, true);
        assertEqual(stale.snapshot.plan, 'Seed');
    }));

    it('an HTTP error body is sanitized and capped at 200 characters', withTemp(({cache}) => {
        const r = runSync(fetchSnapshot(deps(cache, httpStub(res(500, `boom \u001b[31m${'x'.repeat(400)}`)))));
        assertEqual(r.ok, false);
        const err = runSync(cache.readLastError());
        assertEqual(err.code, 500);
        assertEqual(err.body.length <= 200, true);
        assertEqual(err.body.includes('\u001b'), false);
    }));

    it('a 401 never keeps its body', withTemp(({cache}) => {
        const r = runSync(fetchSnapshot(deps(cache, httpStub(res(401, 'token=do-not-leak')))));
        assertEqual(r.code, 'auth-rejected');
        assertEqual(runSync(cache.readLastError()).body, '');
    }));
});

describe('customAdapter.fetchSnapshot', () => {
    const config = over => ({vendors: {custom: {
        name: 'Team API', url: URL, allowHttp: false, apiKeyEnv: null, apiKey: 'k',
        authHeader: 'Authorization', authScheme: 'Bearer', extraHeaders: {}, mapping: MAPPING, ...over,
    }}});

    it('an invalid mapping → invalid-mapping error, no request', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(customAdapter.fetchSnapshot({config: config({mapping: null}), cache, http}));
        assertEqual(http.calls.length, 0);
        assertEqual(r.ok, false);
        assertEqual(r.code, 'invalid-mapping');
    }));

    it('invalid extra headers → invalid-mapping error, no request', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(customAdapter.fetchSnapshot({config: config({extraHeaders: null}), cache, http}));
        assertEqual(http.calls.length, 0);
        assertEqual(r.code, 'invalid-mapping');
    }));

    it('a valid config fetches with the inline key', withTemp(({cache}) => {
        const http = httpStub(res(200, LIVE));
        const r = runSync(customAdapter.fetchSnapshot({config: config({}), cache, http}));
        assertEqual(r.ok, true);
        assertEqual(http.calls[0].headers.Authorization, 'Bearer k');
    }));

    it('the badge comes from the name', () => {
        assertEqual(customAdapter.shortCode(config({name: 'My Tool'})), 'MYT');
    });
});

system.exit(summary());
