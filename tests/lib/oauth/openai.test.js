import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

import {
    refresh, needsRefresh, readAuth, writeBack, applyRefresh, expiresAtSecs, planType, TOKEN_URL,
} from '../../../lib/oauth/openai.js';
import {describe, it, assertEqual, assertThrows, summary} from '../../_assert.js';

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

function b64url(str) {
    const bytes = new TextEncoder().encode(str);
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
        out += A[b0 >> 2];
        out += A[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
        if (b1 === undefined) break;
        out += A[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
        if (b2 === undefined) break;
        out += A[b2 & 63];
    }
    return out;
}
function fakeJwt(claims) {
    return `${b64url(JSON.stringify({alg: 'none'}))}.${b64url(JSON.stringify(claims))}.sig`;
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

function withTempDir(fn) {
    return () => {
        const dir = GLib.Dir.make_tmp('ai-usagebar-codex-XXXXXX');
        try {
            fn({dir, path: GLib.build_filenamev([dir, 'auth.json'])});
        } finally {
            rmRf(dir);
        }
    };
}

function writeText(path, text) {
    Gio.File.new_for_path(path).replace_contents(
        new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.PRIVATE, null);
}
function readText(path) {
    const [, contents] = Gio.File.new_for_path(path).load_contents(null);
    return new TextDecoder().decode(contents);
}

describe('needsRefresh', () => {
    it('true inside the 300s buffer', () => assertEqual(needsRefresh(1_000_000 + 100, 1_000_000), true));
    it('false outside the buffer', () => assertEqual(needsRefresh(1_000_000 + 1000, 1_000_000), false));
});

describe('refresh', () => {
    it('parses access/refresh/id tokens and expires_in on success', () => {
        const http = httpStub(res(200,
            '{"access_token":"new-at","refresh_token":"new-rt","id_token":"new-id","expires_in":3600}'));
        const r = runSync(refresh(http, 'old', {endpoint: TOKEN_URL}));
        assertEqual(r.ok, true);
        assertEqual(r.accessToken, 'new-at');
        assertEqual(r.refreshToken, 'new-rt');
        assertEqual(r.idToken, 'new-id');
        assertEqual(r.expiresIn, 3600);
    });

    it('sends the Codex client_id + scope in the JSON body', () => {
        const http = httpStub(res(200, '{"access_token":"x"}'));
        runSync(refresh(http, 'old', {endpoint: TOKEN_URL}));
        const body = JSON.parse(http.calls[0].body);
        assertEqual(body.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
        assertEqual(body.grant_type, 'refresh_token');
        assertEqual(body.scope, 'openid profile email');
    });

    it('400 surfaces kind:http with the parsed description', () => {
        const http = httpStub(res(400, '{"error":"invalid_grant","error_description":"Refresh expired"}'));
        const r = runSync(refresh(http, 'x', {endpoint: TOKEN_URL}));
        assertEqual(r.ok, false);
        assertEqual(r.kind, 'http');
        assertEqual(r.status, 400);
        assertEqual(r.body, 'Refresh expired');
    });
});

describe('readAuth / expiresAtSecs / planType', () => {
    it('reads tokens and infers expiry + plan from the id_token', withTempDir(({path}) => {
        const jwt = fakeJwt({exp: 1234567890, 'https://api.openai.com/auth': {chatgpt_plan_type: 'plus'}});
        writeText(path, JSON.stringify({tokens: {
            access_token: 'AT', refresh_token: 'RT', id_token: jwt, account_id: 'acc',
        }}));
        const {tokens} = runSync(readAuth(path));
        assertEqual(tokens.accessToken, 'AT');
        assertEqual(tokens.accountId, 'acc');
        assertEqual(expiresAtSecs(tokens), 1234567890);
        assertEqual(planType(tokens), 'plus');
    }));

    it('malformed file throws with the codex-login hint', withTempDir(({path}) => {
        writeText(path, 'not json');
        assertThrows(() => runSync(readAuth(path)));
    }));

    it('expiresAtSecs falls back to 0 for an unparseable id_token', withTempDir(({path}) => {
        writeText(path, JSON.stringify({tokens: {access_token: 'x', refresh_token: 'y', id_token: 'bad'}}));
        assertEqual(expiresAtSecs(runSync(readAuth(path)).tokens), 0);
    }));
});

describe('expiresAtSecs — precedence', () => {
    const tokens = (o) => Object.assign({accessToken: '', refreshToken: 'RT', idToken: '', accountId: null, expiresAt: null}, o);

    it('an RFC 3339 expires_at wins over both JWTs', () =>
        assertEqual(expiresAtSecs(tokens({
            expiresAt: '2030-01-01T00:00:00Z',
            accessToken: fakeJwt({exp: 1}), idToken: fakeJwt({exp: 2}),
        })), Date.parse('2030-01-01T00:00:00Z') / 1000));

    it('falls back to the access_token exp before the id_token exp', () =>
        assertEqual(expiresAtSecs(tokens({
            expiresAt: 'whenever', accessToken: fakeJwt({exp: 1_900_000_000}), idToken: fakeJwt({exp: 2}),
        })), 1_900_000_000));

    it('falls back to the id_token exp when the access token is opaque', () =>
        assertEqual(expiresAtSecs(tokens({accessToken: 'opaque', idToken: fakeJwt({exp: 2_000_000_000})})), 2_000_000_000));

    it('returns 0 (expired) when nothing is usable', () =>
        assertEqual(expiresAtSecs(tokens({accessToken: 'opaque', idToken: 'bad'})), 0));

    it('readAuth ignores a non-string expires_at', withTempDir(({path}) => {
        writeText(path, JSON.stringify({tokens: {access_token: 'x', refresh_token: 'y', id_token: 'bad', expires_at: 1_900_000_000}}));
        const {tokens: t} = runSync(readAuth(path));
        assertEqual(t.expiresAt, null);
        assertEqual(expiresAtSecs(t), 0);
    }));
});

describe('applyRefresh', () => {
    const NOW = 1_800_000_000;
    const tokens = () => ({accessToken: 'AT', refreshToken: 'RT', idToken: 'ID', accountId: null, expiresAt: null});

    it('records expires_in as an explicit expires_at and keeps the old id_token', () => {
        const t = tokens();
        const r = applyRefresh(t, {accessToken: 'NEW', refreshToken: null, idToken: null, expiresIn: 3600}, NOW);
        assertEqual(r.rotated, false);
        assertEqual(t.accessToken, 'NEW');
        assertEqual(t.refreshToken, 'RT');
        assertEqual(t.idToken, 'ID');
        assertEqual(t.expiresAt, new Date((NOW + 3600) * 1000).toISOString());
        assertEqual(expiresAtSecs(t), NOW + 3600);
    });

    it('leaves expires_at alone without expires_in and flags a rotated refresh token', () => {
        const t = tokens();
        t.expiresAt = '2030-01-01T00:00:00Z';
        const r = applyRefresh(t, {accessToken: 'NEW', refreshToken: 'RT2', idToken: 'ID2', expiresIn: null}, NOW);
        assertEqual(r.rotated, true);
        assertEqual(t.refreshToken, 'RT2');
        assertEqual(t.idToken, 'ID2');
        assertEqual(t.expiresAt, '2030-01-01T00:00:00Z');
    });
});

describe('writeBack', () => {
    it('persists the refreshed expires_at', withTempDir(({path}) => {
        writeText(path, JSON.stringify({tokens: {access_token: 'AT', refresh_token: 'RT', id_token: 'ID', expires_at: '2020-01-01T00:00:00Z'}}));
        const auth = runSync(readAuth(path));
        applyRefresh(auth.tokens, {accessToken: 'NEW', refreshToken: null, idToken: null, expiresIn: 600}, 1_800_000_000);
        assertEqual(writeBack(path, auth).ok, true);
        const round = JSON.parse(readText(path));
        assertEqual(round.tokens.expires_at, new Date((1_800_000_000 + 600) * 1000).toISOString());
        assertEqual(round.tokens.access_token, 'NEW');
    }));

    it('reports kind:io when the file cannot be written', withTempDir(({dir}) => {
        const auth = {tokens: {accessToken: 'A', refreshToken: 'R', idToken: 'I', accountId: null, expiresAt: null}, raw: {}};
        const r = writeBack(GLib.build_filenamev([dir, 'missing-dir', 'auth.json']), auth);
        assertEqual(r.ok, false);
        assertEqual(r.kind, 'io');
    }));


    it('preserves unknown top-level and token fields through a round-trip', withTempDir(({path}) => {
        const jwt = fakeJwt({exp: 1234567890});
        writeText(path, JSON.stringify({
            tokens: {access_token: 'AT', refresh_token: 'RT', id_token: jwt, last_refresh_marker: 'keep-tok'},
            some_other_field: 'keep-me',
        }));
        const auth = runSync(readAuth(path));
        auth.tokens.accessToken = 'NEW';
        const r = writeBack(path, auth);
        assertEqual(r.ok, true);

        const round = JSON.parse(readText(path));
        assertEqual(round.some_other_field, 'keep-me');
        assertEqual(round.tokens.access_token, 'NEW');
        assertEqual(round.tokens.last_refresh_marker, 'keep-tok');
    }));
});

system.exit(summary());
