const express = require('express');
const CarBrand = require('../models/CarBrand');

const router = express.Router();

// GET / - fetch all car brands with models and logo URLs
router.get('/', async (req, res) => {
    try {
        const brands = await CarBrand.find().sort({ name: 1 }).lean();
        const baseUrl = `${req.protocol}://${req.get('host')}`;

        const payload = brands.map((brand) => ({
            id: brand._id,
            name: brand.name,
            models: (brand.models || []).map((model) => {
                if (!model) return null;
                if (typeof model === 'string') {
                    return { name: model };
                }
                return {
                    name: model.name,
                    carType: model.carType
                };
            }).filter(Boolean),
            logoUrl: brand.logoFile ? `${baseUrl}/public/brand-logos/${brand.logoFile}` : null
        }));

        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
