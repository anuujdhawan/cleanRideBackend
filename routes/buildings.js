const express = require('express');
const router = express.Router();
const Building = require('../models/Building');
const User = require('../models/User');

// GET / - Get all buildings
router.get('/', async (req, res) => {
    try {
        const buildings = await Building.find()
            .populate('developerId', 'name email')
            .sort({ name: 1 });
        res.json(buildings);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST / - Add a new building
router.post('/', async (req, res) => {
    try {
        const { name, developerId } = req.body;
        if (!name) {
            return res.status(400).json({ message: 'Building name is required' });
        }
        if (!developerId) {
            return res.status(400).json({ message: 'Developer selection is required' });
        }
        const existingBuilding = await Building.findOne({ name });
        if (existingBuilding) {
            return res.status(400).json({ message: 'Building already exists' });
        }
        const developer = await User.findOne({ _id: developerId, role: 'developer' });
        if (!developer) {
            return res.status(400).json({ message: 'Invalid developer selection' });
        }
        const newBuilding = new Building({ name, developerId });
        await newBuilding.save();
        res.status(201).json(newBuilding);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PUT /:id - Update a building (name or developer assignment)
router.put('/:id', async (req, res) => {
    try {
        const { name, developerId } = req.body;
        const updates = {};

        if (name) {
            updates.name = name;
        }

        if (typeof developerId !== 'undefined') {
            return res.status(400).json({ message: 'Developer assignment cannot be changed after creation' });
        }

        const building = await Building.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true }
        ).populate('developerId', 'name email');

        if (!building) {
            return res.status(404).json({ message: 'Building not found' });
        }

        res.json(building);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// DELETE /:id - Delete a building
router.delete('/:id', async (req, res) => {
    try {
        await Building.findByIdAndDelete(req.params.id);
        res.json({ message: 'Building deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Seed route
router.post('/seed', async (req, res) => {
    try {
        const dummyBuildings = [
            'Burj Khalifa',
            'Princess Tower',
            '23 Marina',
            'Elite Residence',
            'The Torch',
            'Ocean Heights',
            'Cayan Tower',
            'Marina Pinnacle',
            'Sulafa Tower',
            'Al Seef Tower'
        ];

        for (const name of dummyBuildings) {
            await Building.findOneAndUpdate(
                { name },
                { name },
                { upsert: true, new: true }
            );
        }
        res.json({ message: 'Database seeded with dummy Dubai buildings' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
