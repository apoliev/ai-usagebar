import GLib from 'gi://GLib';
import system from 'system';

import {fetchSnapshot, quotaUrl} from '../../../../lib/vendors/sourcecraft/main.js';
import {describe, it, assertEqual, assertThrows, summary} from '../../../_assert.js';

const PAYLOAD = new TextEncoder().encode(JSON.stringify({quotas: [
    {quota_id: 'src.cuPrepaidRaw.count', usage: 25, limit: 100},
]}));

function runSync(promise) {
    const loop = GLib.MainLoop.new(null, false);
    let value, error;
    promise.then(v => { value = v; loop.quit(); }, e => { error = e; loop.quit(); });
    loop.run();
    if (error)
        throw error;
    return value;
}

function setup(status = 200, bodyBytes = PAYLOAD) {
    const cache = {
        dir: 'sourcecraft-test', payload: null, fresh: false, lastError: null,
        async freshPayload() { return this.fresh ? this.payload : null; },
        async maybePayload() { return this.payload; },
        async payloadAgeMs() { return 1000; },
        async readLastError() { return this.lastError; },
        writePayload(bytes) { this.payload = bytes; this.fresh = true; },
        markStale() { this.fresh = false; },
        writeLastError(code, message) { this.lastError = {code, message}; },
    };
    const calls = [];
    const deps = {
        cache, apiKey: 'test-token', organization: 'example', signal: {},
        async http(opts) { calls.push(opts); return {status, bodyBytes}; },
    };
    return {cache, calls, deps};
}

describe('SourceCraft fetching', () => {
    it('uses the official API with bearer auth and caches a validated response', () => {
        const {deps, cache, calls} = setup();
        const result = runSync(fetchSnapshot(deps));
        assertEqual(result.ok, true);
        assertEqual(result.snapshot.quotas[0].percent, 25);
        assertEqual(calls[0].url, 'https://api.sourcecraft.tech/orgs/example/quotas');
        assertEqual(calls[0].headers.Authorization, 'Bearer test-token');
        assertEqual(calls[0].cancellable, deps.signal);
        assertEqual(cache.payload, PAYLOAD);
        runSync(fetchSnapshot(deps));
        assertEqual(calls.length, 1);
    });
    for (const status of [401, 403, 429, 500]) {
        it(`preserves stale data on HTTP ${status} without persisting the response body`, () => {
            const {deps, cache} = setup(status, new TextEncoder().encode('sensitive response'));
            cache.payload = PAYLOAD;
            const result = runSync(fetchSnapshot(deps));
            assertEqual(result.ok, true);
            assertEqual(result.stale, true);
            assertEqual(result.lastError.code, status);
            assertEqual(cache.lastError.message.includes('sensitive'), false);
            assertEqual(cache.payload, PAYLOAD);
        });
    }
    it('rejects malformed success responses and preserves the last valid payload', () => {
        const {deps, cache} = setup(200, new TextEncoder().encode('{"message":"oops"}'));
        cache.payload = PAYLOAD;
        const result = runSync(fetchSnapshot(deps));
        assertEqual(result.stale, true);
        assertEqual(cache.payload, PAYLOAD);
    });
    it('returns an error on empty-cache failures instead of showing zero usage', () => {
        const {deps} = setup(403);
        const result = runSync(fetchSnapshot(deps));
        assertEqual(result.ok, false);
        assertEqual(result.kind, 'error');
    });
    it('recovers from corrupt fresh cache by fetching', () => {
        const {deps, cache, calls} = setup();
        cache.payload = 'bad json';
        cache.fresh = true;
        assertEqual(runSync(fetchSnapshot(deps)).ok, true);
        assertEqual(calls.length, 1);
    });
    it('uses stale cache on transport failures', () => {
        const {deps, cache} = setup();
        cache.payload = PAYLOAD;
        deps.http = async () => ({error: new Error('offline'), status: 0});
        assertEqual(runSync(fetchSnapshot(deps)).stale, true);
    });
    it('never rejects on an unexpected dependency failure', () => {
        const {deps} = setup();
        deps.cache.freshPayload = async () => { throw new Error('unreadable'); };
        assertEqual(runSync(fetchSnapshot(deps)).kind, 'error');
    });
    it('rejects missing or path-like organization slugs before a request', () => {
        for (const slug of ['', '../foo', 'foo/bar', 'foo?x=1'])
            assertThrows(() => quotaUrl(slug));
        const {deps, calls} = setup();
        deps.organization = '../foo';
        assertEqual(runSync(fetchSnapshot(deps)).ok, false);
        assertEqual(calls.length, 0);
    });
});

system.exit(summary());
