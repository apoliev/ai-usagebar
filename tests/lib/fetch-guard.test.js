import system from 'system';

import {FetchGuard} from '../../lib/fetch-guard.js';
import {describe, it, assertEqual, summary} from '../_assert.js';

describe('FetchGuard', () => {
    it('a lone run is current and settles without a rerun', () => {
        const g = new FetchGuard();
        const t = g.begin();
        assertEqual(g.busy, true);
        assertEqual(g.isCurrent(t), true);
        assertEqual(g.end(t), false);
        assertEqual(g.busy, false);
    });

    it('requests made while busy coalesce into one pending rerun', () => {
        const g = new FetchGuard();
        const t = g.begin();
        assertEqual(g.begin(), null);
        assertEqual(g.begin(), null);
        assertEqual(g.pending, true);
        assertEqual(g.end(t), true);
        assertEqual(g.pending, false);
        assertEqual(g.busy, false);
    });

    it('supersede makes the in-flight run stale and frees the slot', () => {
        const g = new FetchGuard();
        const old = g.begin();
        g.supersede();
        assertEqual(g.isCurrent(old), false);
        assertEqual(g.busy, false);
        const next = g.begin();
        assertEqual(g.isCurrent(next), true);
        assertEqual(g.busy, true);
    });

    it('a superseded run settling does not release the new run nor consume pending', () => {
        const g = new FetchGuard();
        const old = g.begin();
        g.supersede();
        const next = g.begin();
        g.begin();
        assertEqual(g.end(old), false);
        assertEqual(g.busy, true);
        assertEqual(g.pending, true);
        assertEqual(g.end(next), true);
    });

    it('a null token is never current', () =>
        assertEqual(new FetchGuard().isCurrent(null), false));
});

system.exit(summary());
