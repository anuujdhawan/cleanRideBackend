const getRequestBaseUrl = (req) => {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const rawProto = Array.isArray(forwardedProto)
        ? forwardedProto[0]
        : forwardedProto;
    const protocol = (rawProto && String(rawProto).split(',')[0].trim()) || req.protocol;
    const host = req.get('host') || req.headers.host;

    if (!host) {
        return `${protocol}://localhost`;
    }

    return `${protocol}://${host}`;
};

module.exports = {
    getRequestBaseUrl
};
