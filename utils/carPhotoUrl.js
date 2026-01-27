const { getRequestBaseUrl } = require('./requestBaseUrl');

const isAbsolutePhotoValue = (value) => {
    if (!value) return false;
    const normalized = String(value);
    return normalized.startsWith('data:') || normalized.startsWith('http://') || normalized.startsWith('https://');
};

const resolveCarPhotoUrl = (req, photo) => {
    if (!photo) return null;
    if (isAbsolutePhotoValue(photo)) return photo;
    const baseUrl = getRequestBaseUrl(req);
    return `${baseUrl}/public/car-photos/${photo}`;
};

module.exports = {
    resolveCarPhotoUrl,
    isAbsolutePhotoValue,
};
