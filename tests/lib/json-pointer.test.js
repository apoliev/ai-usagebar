import system from 'system';

import {resolve, isValidPointer} from '../../lib/json-pointer.js';
import {describe, it, assertEqual, assertDeepEqual, summary} from '../_assert.js';

const DOC = {
    foo: ['bar', 'baz'],
    '': 0,
    'a/b': 1,
    'm~n': 8,
    nested: {deep: {value: null, zero: 0, flag: false}},
};

describe('resolve', () => {
    it('follows object keys and array indices', () => {
        assertDeepEqual(resolve(DOC, '/foo'), ['bar', 'baz']);
        assertEqual(resolve(DOC, '/foo/0'), 'bar');
        assertEqual(resolve(DOC, '/foo/1'), 'baz');
    });

    it('decodes ~1 as / and ~0 as ~', () => {
        assertEqual(resolve(DOC, '/a~1b'), 1);
        assertEqual(resolve(DOC, '/m~0n'), 8);
    });

    it('resolves the empty key and falsy values', () => {
        assertEqual(resolve(DOC, '/'), 0);
        assertEqual(resolve(DOC, '/nested/deep/value'), null);
        assertEqual(resolve(DOC, '/nested/deep/zero'), 0);
        assertEqual(resolve(DOC, '/nested/deep/flag'), false);
    });

    it('returns undefined for anything that does not resolve', () => {
        assertEqual(resolve(DOC, '/missing'), undefined);
        assertEqual(resolve(DOC, '/foo/2'), undefined);
        assertEqual(resolve(DOC, '/foo/01'), undefined);
        assertEqual(resolve(DOC, '/foo/-'), undefined);
        assertEqual(resolve(DOC, '/foo/0/x'), undefined);
        assertEqual(resolve(DOC, '/nested/deep/value/x'), undefined);
        assertEqual(resolve(DOC, 'foo'), undefined);
    });

    it('never walks the prototype chain', () =>
        assertEqual(resolve(DOC, '/toString'), undefined));

    it('"" is the whole document', () => assertEqual(resolve(DOC, ''), DOC));
});

describe('isValidPointer', () => {
    it('accepts pointers that start with /', () => {
        assertEqual(isValidPointer('/a'), true);
        assertEqual(isValidPointer('/a/0/b~1c'), true);
        assertEqual(isValidPointer('/'), true);
    });

    it('rejects the root, relative paths, controls and non-strings', () => {
        assertEqual(isValidPointer(''), false);
        assertEqual(isValidPointer('a/b'), false);
        assertEqual(isValidPointer('/a\nb'), false);
        assertEqual(isValidPointer('/a\u0085'), false);
        assertEqual(isValidPointer(null), false);
    });
});

system.exit(summary());
