export const VENDOR_IDS = Object.freeze([
    'anthropic',
    'openai',
    'zai',
    'openrouter',
    'deepseek',
    'kimi',
    'sourcecraft',
    'ollama',
    'custom',
]);

export const VENDOR_LABELS = Object.freeze([
    'Anthropic',
    'OpenAI',
    'Z.AI',
    'OpenRouter',
    'DeepSeek',
    'Kimi',
    'SourceCraft',
    'Ollama',
    'Custom',
]);

export function isVendorId(s) {
    return VENDOR_IDS.includes(s);
}

export const GENERIC_ICON = 'ai-symbolic';
// Vendors with no mark of their own under icons/.
export const GENERIC_ICON_VENDORS = Object.freeze(['custom']);

// The symbolic icon name of a vendor's mark (icons/<name>.svg).
export function vendorIconName(id) {
    return isVendorId(id) && !GENERIC_ICON_VENDORS.includes(id) ? `${id}-symbolic` : GENERIC_ICON;
}

// The custom provider is labelled by the name the user gave it.
export function vendorLabel(id, config = null) {
    if (id === 'custom' && config?.vendors?.custom?.name)
        return config.vendors.custom.name;
    const i = VENDOR_IDS.indexOf(id);
    return i === -1 ? id : VENDOR_LABELS[i];
}
