const CarBrand = require('../models/CarBrand');
const carBrands = require('../data/carBrands');

const normalizeToken = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const inferCarType = (brandName, modelName) => {
    if (!modelName) return null;
    const modelRaw = String(modelName).trim();
    if (!modelRaw) return null;

    const modelKey = normalizeToken(modelRaw);
    if (!modelKey || modelKey === 'other') return null;

    const brandKey = normalizeToken(brandName || '');

    if (brandKey.includes('audi') && /^q[78]/.test(modelKey)) return 'large-suv';
    if (brandKey.includes('audi') && /^q\d/.test(modelKey)) return 'mid-suv';

    if (brandKey.includes('bmw') && (/^x[567]/.test(modelKey) || /^ix\d/.test(modelKey) || modelKey === 'ix')) return 'large-suv';
    if (brandKey.includes('bmw') && /^x[1-4]/.test(modelKey)) return 'mid-suv';

    if (brandKey.includes('mercedes')) {
        if (/^gls/.test(modelKey) || modelKey.startsWith('gclass') || modelKey === 'g' || modelKey === 'g63') {
            return 'large-suv';
        }
        if (/^gle/.test(modelKey)) return 'large-suv';
        if (/^gl[abce]/.test(modelKey)) return 'mid-suv';
    }

    if (brandKey.includes('lexus')) {
        if (/^(lx|gx)/.test(modelKey)) return 'large-suv';
        if (/^(rx|nx|ux)/.test(modelKey)) return 'mid-suv';
    }

    if (brandKey.includes('infiniti')) {
        if (/^qx80/.test(modelKey)) return 'large-suv';
        if (/^qx/.test(modelKey)) return 'mid-suv';
    }

    if (brandKey.includes('volvo')) {
        if (/^xc90/.test(modelKey)) return 'large-suv';
        if (/^xc/.test(modelKey)) return 'mid-suv';
    }

    if (brandKey.includes('acura')) {
        if (modelKey === 'mdx') return 'large-suv';
        if (modelKey === 'rdx') return 'mid-suv';
    }

    if (brandKey.includes('porsche')) {
        if (modelKey === 'cayenne') return 'large-suv';
        if (modelKey === 'macan') return 'mid-suv';
    }

    const hatchKeywords = [
        'hatch',
        'sportback',
        'swift',
        'micra',
        'polo',
        'golf',
        'fiesta',
        'i10',
        'i20',
        'picanto',
        'rio',
        'yaris',
        'aygo',
        'up',
        'spark',
        'fit',
        'mini',
        'cooper',
        '500'
    ];

    if (hatchKeywords.some((token) => modelKey.includes(token))) {
        return 'hatchback';
    }

    const largeSuvKeywords = [
        'escalade',
        'tahoe',
        'suburban',
        'yukon',
        'expedition',
        'navigator',
        'armada',
        'sequoia',
        'landcruiser',
        'prado',
        'fortuner',
        'patrol',
        'rangerover',
        'defender',
        'discovery',
        'gclass',
        'gwagen',
        'gwagon',
        'gls',
        'gle',
        'q7',
        'q8',
        'x5',
        'x6',
        'x7',
        'ix',
        'xc90',
        'gx',
        'lx',
        'qx80',
        'gv80',
        'telluride',
        'palisade',
        'atlas',
        'touareg',
        'kodiaq',
        'traverse',
        'enclave',
        'grandcherokee',
        'wagoneer'
    ];

    if (largeSuvKeywords.some((token) => modelKey.includes(token))) {
        return 'large-suv';
    }

    const suvKeywords = [
        'suv',
        'crossover',
        'xtrail',
        'qashqai',
        'rav4',
        'crv',
        'hrv',
        'brv',
        'cx3',
        'cx5',
        'cx30',
        'cx50',
        'cx60',
        'cx70',
        'cx90',
        'outback',
        'forester',
        'ascent',
        'rogue',
        'pathfinder',
        'murano',
        'juke',
        'kicks',
        'tucson',
        'santafe',
        'palisade',
        'kona',
        'sportage',
        'sorento',
        'telluride',
        'seltos',
        'soul',
        'tiguan',
        'touareg',
        'atlas',
        'taos',
        'troc',
        'karoq',
        'kodiaq',
        'enclave',
        'envision',
        'encore',
        'explorer',
        'escape',
        'edge',
        'ecosport',
        'bronco',
        'blazer',
        'trailblazer',
        'traverse',
        'equinox',
        'rangerover',
        'defender',
        'discovery',
        'evoque',
        'velar',
        'wrangler',
        'cherokee',
        'grandcherokee',
        'compass',
        'renegade',
        'gclass',
        'gwagen',
        'gwagon',
        'g63',
        'x1',
        'x2',
        'x3',
        'x4',
        'q3',
        'q5',
        'ux',
        'nx',
        'rx',
        'gx',
        'lx',
        'qx',
        'qx50',
        'qx60',
        'qx70',
        'qx80',
        'qx55',
        'xt4',
        'xt5',
        'xt6',
        'gv60',
        'gv70',
        'gv80',
        'cayenne',
        'macan'
    ];

    if (suvKeywords.some((token) => modelKey.includes(token))) {
        return 'mid-suv';
    }

    return 'sedan';
};

const normalizeModels = (brand) => {
    const models = Array.isArray(brand.models) ? brand.models : [];

    return models
        .map((model) => {
            if (typeof model === 'string') {
                const carType = inferCarType(brand.name, model);
                return carType ? { name: model, carType } : { name: model };
            }
            if (!model || !model.name) return null;
            const carType = model.carType || inferCarType(brand.name, model.name);
            return carType ? { name: model.name, carType } : { name: model.name };
        })
        .filter(Boolean);
};

const seedCarBrands = async () => {
    try {
        if (!carBrands.length) return;

        const ops = carBrands.map((brand) => ({
            updateOne: {
                filter: { name: brand.name },
                update: {
                    $set: {
                        name: brand.name,
                        models: normalizeModels(brand),
                        logoFile: brand.logoFile || null
                    }
                },
                upsert: true
            }
        }));

        await CarBrand.bulkWrite(ops);
        console.log(`Car brands seed complete (${carBrands.length} entries).`);
    } catch (error) {
        console.error('Failed to seed car brands:', error);
    }
};

module.exports = { seedCarBrands };
