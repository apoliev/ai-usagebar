// RFC 6901 JSON Pointer. Pure, so the custom provider's mapping is testable.

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;

// The whole-document pointer "" is rejected: a mapping must name a field.
export function isValidPointer(s) {
    return typeof s === 'string' && s.startsWith('/') && !CONTROL.test(s);
}

function unescapeToken(token) {
    return token.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

// The value at `pointer`, or undefined when it does not resolve (JSON has no
// undefined, so the two cannot be confused).
export function resolve(obj, pointer) {
    if (pointer === '')
        return obj;
    if (typeof pointer !== 'string' || !pointer.startsWith('/'))
        return undefined;
    let cur = obj;
    for (const raw of pointer.slice(1).split('/')) {
        const token = unescapeToken(raw);
        if (Array.isArray(cur)) {
            if (!/^(0|[1-9]\d*)$/u.test(token))
                return undefined;
            cur = cur[Number(token)];
        } else if (cur !== null && typeof cur === 'object') {
            cur = Object.hasOwn(cur, token) ? cur[token] : undefined;
        } else {
            return undefined;
        }
        if (cur === undefined)
            return undefined;
    }
    return cur;
}
