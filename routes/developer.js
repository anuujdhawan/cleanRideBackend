const express = require('express');
const jwt = require('jsonwebtoken');
const Building = require('../models/Building');
const User = require('../models/User');
const Car = require('../models/Car');
const Subscription = require('../models/Subscription');
const {
    calculateSubscriptionRevenueInRange,
    summarizeSubscriptionsRevenueInRange
} = require('../utils/subscriptionRevenue');

const router = express.Router();

const verifyToken = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET || 'fallback_secret_key',
            { ignoreExpiration: true }
        );
        const role = decoded?.role;

        if (role !== 'client' && role !== 'cleaner') {
            if (!decoded?.exp) {
                return res.status(401).json({ message: 'Token expired.' });
            }

            const nowSeconds = Math.floor(Date.now() / 1000);
            if (decoded.exp <= nowSeconds) {
                return res.status(401).json({ message: 'Token expired.' });
            }
        }

        req.user = decoded;
        next();
    } catch (error) {
        res.status(400).json({ message: 'Invalid token.' });
    }
};

const requireDeveloper = (req, res, next) => {
    if (req.user?.role !== 'developer') {
        return res.status(403).json({ message: 'Access denied. Developer role required.' });
    }

    next();
};

const getMonthIndex = (monthParam) => {
    const parsedMonth = parseInt(monthParam, 10);
    if (Number.isInteger(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12) {
        return parsedMonth - 1;
    }

    return new Date().getMonth();
};

const getYear = (yearParam) => {
    const parsedYear = parseInt(yearParam, 10);
    if (Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 3000) {
        return parsedYear;
    }

    return new Date().getFullYear();
};

const getSortTimestamp = (subscription) => {
    const sourceDate = subscription.startDate || subscription.createdAt || 0;
    return new Date(sourceDate).getTime();
};

const getSnapshotCreatedAtQuery = (snapshotEnd) => ({
    $or: [
        { createdAt: { $lte: snapshotEnd } },
        { createdAt: null },
        { createdAt: { $exists: false } }
    ]
});

// GET /buildings - developer-owned buildings
router.get('/buildings', verifyToken, requireDeveloper, async (req, res) => {
    try {
        const buildings = await Building.find({ developerId: req.user.userId }).sort({ name: 1 }).lean();
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
        }).lean();

        if (!building) {
            return res.status(404).json({ message: 'Building not found' });
        }

        const year = getYear(req.query.year);
        const monthIndex = getMonthIndex(req.query.month);
        const monthStart = new Date(year, monthIndex, 1);
        const monthEnd = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
        const now = new Date();
        const selectedMonthIsCurrent = year === now.getFullYear() && monthIndex === now.getMonth();
        const snapshotEnd = selectedMonthIsCurrent ? now : monthEnd;
        const revenueRangeEnd = selectedMonthIsCurrent ? now : monthEnd;

        const clients = await User.find({
            role: 'client',
            buildingName: building.name,
            ...getSnapshotCreatedAtQuery(snapshotEnd)
        })
            .select('name email phone buildingName')
            .sort({ name: 1, createdAt: 1 })
            .lean();

        const clientIds = clients.map((client) => client._id);

        const cars = clientIds.length
            ? await Car.find({
                clientId: { $in: clientIds },
                ...getSnapshotCreatedAtQuery(snapshotEnd)
            })
                .select('make model color licensePlate type clientId')
                .sort({ createdAt: -1 })
                .lean()
            : [];

        const clientCarMap = new Map();
        cars.forEach((car) => {
            const clientId = car.clientId?.toString();
            if (!clientId) {
                return;
            }

            const clientCars = clientCarMap.get(clientId) || [];
            clientCars.push(car);
            clientCarMap.set(clientId, clientCars);
        });

        const overlappingSubscriptions = clientIds.length
            ? await Subscription.find({
                userId: { $in: clientIds },
                startDate: { $lte: monthEnd },
                $or: [
                    { endDate: { $gte: monthStart } },
                    { endDate: null },
                    { endDate: { $exists: false } }
                ]
            })
                .select('userId carId status startDate endDate createdAt planDetails')
                .sort({ startDate: -1, createdAt: -1 })
                .lean()
            : [];

        const revenueSubscriptions = clientIds.length
            ? await Subscription.find({
                userId: { $in: clientIds }
            })
                .select('userId carId status startDate endDate createdAt planDetails statusHistory')
                .lean()
            : [];

        const subscriptionByCarId = new Map();

        overlappingSubscriptions.forEach((subscription) => {
            const subscriptionUserId = subscription.userId?.toString();
            const directCarId = subscription.carId?.toString();
            const fallbackCars = subscriptionUserId ? clientCarMap.get(subscriptionUserId) || [] : [];
            const resolvedCarId = directCarId || (fallbackCars.length === 1 ? fallbackCars[0]._id.toString() : null);

            if (!resolvedCarId) {
                return;
            }

            const currentBest = subscriptionByCarId.get(resolvedCarId);
            if (!currentBest || getSortTimestamp(subscription) > getSortTimestamp(currentBest)) {
                subscriptionByCarId.set(resolvedCarId, subscription);
            }
        });

        const clientMonthlyTotals = {};
        const monthlyRevenueSummary = summarizeSubscriptionsRevenueInRange(
            revenueSubscriptions,
            monthStart,
            revenueRangeEnd
        );
        const monthlyRevenue = monthlyRevenueSummary.total;

        revenueSubscriptions.forEach((subscription) => {
            const clientId = subscription.userId?.toString();
            if (!clientId) {
                return;
            }

            const revenueSummary = calculateSubscriptionRevenueInRange(
                subscription,
                monthStart,
                revenueRangeEnd
            );

            if (!revenueSummary.total) {
                return;
            }

            clientMonthlyTotals[clientId] = (clientMonthlyTotals[clientId] || 0) + revenueSummary.total;
        });

        const clientsWithTotals = clients.map((client) => ({
            ...client,
            monthlyAmount: clientMonthlyTotals[client._id.toString()] || 0
        }));

        const carsWithSubscriptions = cars.map((car) => {
            const matchedSubscription = subscriptionByCarId.get(car._id.toString());

            return {
                ...car,
                subscriptionStatus: matchedSubscription ? 'active' : 'inactive',
                subscriptionPrice: matchedSubscription?.planDetails?.price ?? null,
                subscriptionPlanType: matchedSubscription?.planDetails?.type || matchedSubscription?.planDetails?.planType || null
            };
        });

        res.json({
            building: { id: building._id, name: building.name },
            totals: {
                clients: clients.length,
                cars: cars.length,
                monthlyRevenue
            },
            clients: clientsWithTotals,
            cars: carsWithSubscriptions,
            selectedMonth: monthIndex + 1,
            selectedYear: year,
            monthLabel: new Date(year, monthIndex, 1).toLocaleString('en-US', {
                month: 'long',
                year: 'numeric'
            })
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
