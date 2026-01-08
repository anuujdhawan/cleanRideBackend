const express = require('express');
const jwt = require('jsonwebtoken');
const Building = require('../models/Building');
const User = require('../models/User');
const Car = require('../models/Car');
const Subscription = require('../models/Subscription');

const router = express.Router();

const verifyToken = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key');
        req.user = decoded;
        next();
    } catch (ex) {
        res.status(400).json({ message: 'Invalid token.' });
    }
};

const requireDeveloper = (req, res, next) => {
    if (req.user?.role !== 'developer') {
        return res.status(403).json({ message: 'Access denied. Developer role required.' });
    }
    next();
};

// GET /buildings - developer-owned buildings
router.get('/buildings', verifyToken, requireDeveloper, async (req, res) => {
    try {
        const buildings = await Building.find({ developerId: req.user.userId }).sort({ name: 1 });
        res.json(buildings);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /buildings/:id/summary - building details for developer
router.get('/buildings/:id/summary', verifyToken, requireDeveloper, async (req, res) => {
    try {
        const building = await Building.findOne({
            _id: req.params.id,
            developerId: req.user.userId
        });

        if (!building) {
            return res.status(404).json({ message: 'Building not found' });
        }

        const clients = await User.find({
            role: 'client',
            buildingName: building.name
        }).select('name email phone buildingName');

        const clientIds = clients.map(client => client._id);

        const cars = clientIds.length
            ? await Car.find({ clientId: { $in: clientIds } })
                .select('make model color licensePlate type clientId')
            : [];

        const now = new Date();
        const currentYear = now.getFullYear();
        const requestedMonth = parseInt(req.query.month, 10);
        const monthIndex = Number.isInteger(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12
            ? requestedMonth - 1
            : now.getMonth();
        const monthStart = new Date(currentYear, monthIndex, 1);
        const monthEnd = new Date(currentYear, monthIndex + 1, 0, 23, 59, 59, 999);

        const subscriptions = clientIds.length
            ? await Subscription.find({
                userId: { $in: clientIds },
                startDate: { $lte: monthEnd },
                $or: [
                    { endDate: { $gte: monthStart } },
                    { endDate: null },
                    { endDate: { $exists: false } }
                ]
            })
            : [];

        const monthlyRevenue = subscriptions.reduce((sum, sub) => sum + (sub.planDetails?.price || 0), 0);

        res.json({
            building: { id: building._id, name: building.name },
            totals: {
                clients: clients.length,
                cars: cars.length,
                monthlyRevenue
            },
            clients,
            cars,
            monthLabel: new Date(currentYear, monthIndex, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
