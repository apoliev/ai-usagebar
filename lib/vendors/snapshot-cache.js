// The cache holds the projected snapshot, never a raw response body: only
// fields a renderer reads reach disk, so a field a vendor adds later (an
// email, an account id) cannot quietly start living in ~/.cache.

const DATE_KEY = '$date';

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function encodeSnapshot(snapshot, cacheVersion) {
    return JSON.stringify({cacheVersion, snapshot}, function (key, value) {
        const raw = this[key];
        return raw instanceof Date ? {[DATE_KEY]: raw.getTime()} : value;
    });
}

// Anything without our exact version — an older format, a raw body cached by
// a previous release — throws, so the caller treats it as corrupt and refetches.
export function decodeSnapshot(bytesOrText, cacheVersion, SchemaError) {
    const text = bytesOrText instanceof Uint8Array
        ? new TextDecoder().decode(bytesOrText)
        : String(bytesOrText);
    let obj;
    try {
        obj = JSON.parse(text, (_key, value) => {
            if (isObject(value) && Object.keys(value).length === 1 && Number.isFinite(value[DATE_KEY]))
                return new Date(value[DATE_KEY]);
            return value;
        });
    } catch (e) {
        throw new SchemaError(`cache unparseable: ${e?.message ?? e}`);
    }
    if (!isObject(obj) || obj.cacheVersion !== cacheVersion)
        throw new SchemaError(`cache: expected cacheVersion ${cacheVersion}`);
    if (!isObject(obj.snapshot))
        throw new SchemaError('cache: missing snapshot');
    return obj.snapshot;
}
