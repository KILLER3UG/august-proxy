const SENSITIVE_KEY_PATTERN = /(api[-_]?key|token|secret|authorization|password|credential|cookie)/i;

function maskSecretValue(value) {
    if (value === null || value === undefined || value === '') return value;
    const text = String(value);
    if (/^\$\{env:/i.test(text)) return text;
    if (text.length <= 10) return '***';
    return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function redactForDisplay(value, keyName = '') {
    if (SENSITIVE_KEY_PATTERN.test(keyName)) return maskSecretValue(value);
    if (Array.isArray(value)) return value.map(item => redactForDisplay(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, redactForDisplay(child, key)])
        );
    }
    return value;
}

module.exports = {
    maskSecretValue,
    redactForDisplay,
    SENSITIVE_KEY_PATTERN
};
