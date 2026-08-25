const express = require('express');
const path = require('path');
const router = express.Router();
const User = require('../models/User');
const Car = require('../models/Car');
const Schedule = require('../models/Schedule');
const Subscription = require('../models/Subscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const ActivityLog = require('../models/ActivityLog');
const Review = require('../models/Review');
const Contact = require('../models/Contact');
const WashRecord = require('../models/WashRecord');
const Building = require('../models/Building');
const { logActivity } = require('../utils/activityLogger');
const { resolveCarPhotoUrl } = require('../utils/carPhotoUrl');
const { summarizeSubscriptionsRevenueInRange } = require('../utils/subscriptionRevenue');
const bcrypt = require('bcrypt');
const validate = require('../middleware/validate');
const { registerSchema, registerBaseSchema } = require('../schemas');

const { Types } = require('mongoose');

// Load env vars from the server folder even when started from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let stripe = null;
const stripeKey = process.env.STRIPE_SECRET_KEY;
const STRIPE_API_VERSION = '2023-10-16';

if (stripeKey && stripeKey.startsWith('sk_')) {
    stripe = require('stripe')(stripeKey, { apiVersion: STRIPE_API_VERSION });
} else {
    console.warn('Stripe key is missing or invalid. Admin subscription updates will skip Stripe calls.');
}

const STRIPE_CALL_TIMEOUT_MS = 15000;
const ADMIN_ALLOWED_SUBSCRIPTION_STATUSES = new Set(['active', 'on_hold', 'cancelled']);

const normalizeAdminSubscriptionStatus = (status) => {
    const raw = String(status || '').trim().toLowerCase();
    if (!raw) return null;

    const normalized = raw.replace(/[\s-]+/g, '_');
    if (normalized === 'onhold') return 'on_hold';
    if (normalized === 'canceled') return 'cancelled';

    return ADMIN_ALLOWED_SUBSCRIPTION_STATUSES.has(normalized) ? normalized : null;
};

const resolveLocalStatusFromStripe = (stripeSubscription) => {
    const stripeStatus = String(stripeSubscription?.status || '').toLowerCase();
    if (stripeStatus === 'canceled' || stripeStatus === 'cancelled') {
        return 'cancelled';
    }
    if (stripeStatus === 'active' || stripeStatus === 'trialing') {
        return stripeSubscription?.pause_collection ? 'on_hold' : 'active';
    }
    return 'inactive';
};

const withStripeTimeout = async (promise, fallbackMessage) => {
    let timeoutId = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(fallbackMessage));
                }, STRIPE_CALL_TIMEOUT_MS);
            })
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};

const toStripeUnitAmount = (amount) => {
    const parsed = typeof amount === 'number' ? amount : Number(amount);
    return Math.round((Number.isFinite(parsed) ? parsed : 0) * 100);
};

const hasDeveloperBuildingAssignment = (body) => (
    Object.prototype.hasOwnProperty.call(body, 'buildingIds')
    || Object.prototype.hasOwnProperty.call(body, 'buildingId')
);

const normalizeDeveloperBuildingIds = (body) => {
    const rawIds = Array.isArray(body.buildingIds)
        ? body.buildingIds
        : (body.buildingId ? [body.buildingId] : []);

    return [...new Set(rawIds.filter(Boolean).map((id) => id.toString()))];
};

const getBuildingIdsValidationError = async (buildingIds, allowedDeveloperId = null) => {
    const invalidIds = buildingIds.filter((id) => !Types.ObjectId.isValid(id));
    if (invalidIds.length) {
        return 'Invalid building selection';
    }

    if (!buildingIds.length) {
        return null;
    }

    const buildings = await Building.find({ _id: { $in: buildingIds } })
        .select('name developerId')
        .lean();

    if (buildings.length !== buildingIds.length) {
        return 'One or more selected buildings do not exist';
    }

    const allowedDeveloperIdString = allowedDeveloperId ? allowedDeveloperId.toString() : null;
    const conflictingBuilding = buildings.find((building) => (
        building.developerId
        && (!allowedDeveloperIdString || building.developerId.toString() !== allowedDeveloperIdString)
    ));

    if (conflictingBuilding) {
        return `${conflictingBuilding.name} is already assigned to another developer`;
    }

    return null;
};

const assignBuildingsToDeveloper = async (developerId, buildingIds) => {
    await Building.updateMany(
        { developerId, _id: { $nin: buildingIds } },
        { $unset: { developerId: "" } }
    );

    if (buildingIds.length) {
        await Building.updateMany(
            { _id: { $in: buildingIds } },
            { $set: { developerId } }
        );
    }
};

const ensurePlanStripePricing = async (plan) => {
    if (!stripe || !plan) return plan;

    const desiredCurrency = 'aed';
    const desiredUnitAmount = toStripeUnitAmount(plan.price);

    if (!desiredUnitAmount || desiredUnitAmount <= 0) return plan;

    if (!plan.stripeProductId) {
        const product = await stripe.products.create({
            name: `${String(plan.planType || '').toUpperCase()} - ${String(plan.carType || '').toUpperCase()}`,
            metadata: { planId: String(plan._id) }
        });
        plan.stripeProductId = product.id;
    }

    let stripePrice = null;
    if (plan.stripePriceId) {
        try {
            stripePrice = await stripe.prices.retrieve(plan.stripePriceId);
        } catch (error) {
            console.warn('Stripe price lookup failed:', error.message);
            plan.stripePriceId = null;
        }
    }

    const priceCurrency = stripePrice?.currency ? String(stripePrice.currency).toLowerCase() : null;
    const priceUnitAmount = typeof stripePrice?.unit_amount === 'number' ? stripePrice.unit_amount : null;
    const isRecurring = stripePrice?.recurring?.interval === 'month';
    const isTrialPrice = Boolean(stripePrice?.recurring?.trial_period_days);
    const isActive = stripePrice ? stripePrice.active !== false : false;
    const productMatches = stripePrice?.product
        ? String(stripePrice.product) === String(plan.stripeProductId)
        : true;

    const needsNewPrice = !stripePrice
        || !isActive
        || !isRecurring
        || isTrialPrice
        || priceCurrency !== desiredCurrency
        || priceUnitAmount !== desiredUnitAmount
        || !productMatches;

    if (needsNewPrice) {
        const price = await stripe.prices.create({
            unit_amount: desiredUnitAmount,
            currency: desiredCurrency,
            recurring: { interval: 'month' },
            product: plan.stripeProductId,
            metadata: { planId: String(plan._id) }
        });
        plan.stripePriceId = price.id;
        plan.stripeCurrency = desiredCurrency;
        plan.stripeUnitAmount = desiredUnitAmount;
    } else {
        if (plan.stripeCurrency !== desiredCurrency) {
            plan.stripeCurrency = desiredCurrency;
        }
        if (plan.stripeUnitAmount !== desiredUnitAmount) {
            plan.stripeUnitAmount = desiredUnitAmount;
        }
    }

    if (plan.isModified()) {
        await plan.save();
    }

    return plan;
};

const sanitizeCustomerRecord = (customer) => {
    if (!customer) return customer;
    const sanitized = customer.toObject ? customer.toObject() : { ...customer };
    delete sanitized.password;
    delete sanitized.secretAnswer;
    delete sanitized.secretQuestion;
    return sanitized;
};

const getLatestSubscriptionsByCar = (subscriptions = []) => {
    const latestByCar = new Map();
    subscriptions.forEach((subscription) => {
        const carId = subscription?.carId?.toString?.();
        if (!carId || latestByCar.has(carId)) return;
        latestByCar.set(carId, subscription);
    });
    return latestByCar;
};

const getCustomerDeleteState = (cars = [], subscriptions = []) => {
    const hasBlockingSubscription = (subscription) => {
        const status = String(subscription?.status || '').toLowerCase();
        return status === 'active' || status === 'on_hold';
    };

    if (!cars.length) {
        const openSubscriptions = subscriptions.filter(hasBlockingSubscription);

        if (openSubscriptions.length) {
            return {
                canDeleteAccount: false,
                deleteBlockedReason: 'Customer has active subscription records.'
            };
        }

        return { canDeleteAccount: true, deleteBlockedReason: null };
    }

    const latestByCar = getLatestSubscriptionsByCar(subscriptions);
    const blockedCars = cars.filter((car) => {
        const latestSubscription = latestByCar.get(car._id.toString());
        if (!latestSubscription) return false;
        return hasBlockingSubscription(latestSubscription);
    });

    const carIdSet = new Set(cars.map((car) => car._id.toString()));
    const orphanOpenSubscriptions = subscriptions.filter((subscription) => {
        const carId = subscription?.carId?.toString?.();
        if (carId && carIdSet.has(carId)) return false;
        return hasBlockingSubscription(subscription);
    });

    if (!blockedCars.length && !orphanOpenSubscriptions.length) {
        return { canDeleteAccount: true, deleteBlockedReason: null };
    }

    return {
        canDeleteAccount: false,
        deleteBlockedReason: blockedCars.length
            ? 'All existing car subscriptions must be inactive or cancelled before deleting this user.'
            : 'Customer has active subscription records.'
    };
};

// GET /dashboard
router.get('/dashboard', async (req, res) => {
    try {
        const { buildingId } = req.query;
        let buildingName = null;
        let clientIds = null;

        if (buildingId && buildingId !== 'all') {
            const building = await Building.findById(buildingId);
            if (!building) {
                return res.status(404).json({ message: 'Building not found' });
            }
            buildingName = building.name;
            const clients = await User.find({ role: 'client', buildingName }).select('_id');
            clientIds = clients.map((client) => client._id);
        }

        const activeSubscriptions = await Subscription.countDocuments({
            status: 'active',
            ...(clientIds ? { userId: { $in: clientIds } } : {})
        });

        const totalCleaners = await User.countDocuments({
            role: 'cleaner',
            ...(buildingName ? { buildingAssigned: buildingName } : {})
        });

        // Car types breakdown
        const carBaseQuery = clientIds && clientIds.length
            ? { clientId: { $in: clientIds } }
            : clientIds
                ? { clientId: { $in: [] } }
                : {};

        const hatchbacks = await Car.countDocuments({
            ...carBaseQuery,
            type: { $in: ['hatchback', 'hatchback-small'] }
        });
        const sedans = await Car.countDocuments({
            ...carBaseQuery,
            type: 'sedan'
        });
        const midSUVs = await Car.countDocuments({
            ...carBaseQuery,
            type: { $in: ['mid-suv', 'sedan/mid-SUV'] }
        });
        const largeSUVs = await Car.countDocuments({
            ...carBaseQuery,
            type: { $in: ['large-suv', 'SUV-large'] }
        });

        const recentRegistrations = await User.find({
            role: 'client',
            ...(buildingName ? { buildingName } : {})
        })
            .sort({ createdAt: -1 })
            .limit(5);

        // Calculate monthly subscription revenue from billing cycles so renewals are included.
        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const pastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const pastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
        const revenueSubscriptions = await Subscription.find({
            ...(clientIds ? { userId: { $in: clientIds } } : {})
        }).lean();

        const currentMonthRevenueSummary = summarizeSubscriptionsRevenueInRange(
            revenueSubscriptions,
            currentMonthStart,
            now
        );
        const pastMonthRevenueSummary = summarizeSubscriptionsRevenueInRange(
            revenueSubscriptions,
            pastMonthStart,
            pastMonthEnd
        );

        const revenueData = {
            currentMonth: currentMonthRevenueSummary.total,
            pastMonth: pastMonthRevenueSummary.total,
            currentMonthBreakdown: {
                new: currentMonthRevenueSummary.newRevenue,
                renewals: currentMonthRevenueSummary.renewalRevenue
            },
            pastMonthBreakdown: {
                new: pastMonthRevenueSummary.newRevenue,
                renewals: pastMonthRevenueSummary.renewalRevenue
            },
            labels: ["Current Month", "Past Month"],
            datasets: [
                {
                    data: [currentMonthRevenueSummary.total, pastMonthRevenueSummary.total]
                }
            ]
        };

        // Real Activity Log
        const activities = await ActivityLog.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();

        const activityLog = activities.map(log => ({
            id: log._id,
            text: log.message,
            date: new Date(log.createdAt).toLocaleString(),
            type: log.type === 'wash_status' ? 'success' : 'info'
        }));

        res.json({
            activeSubscriptions,
            totalCleaners,
            carTypes: {
                hatchback: hatchbacks,
                sedan: sedans,
                'mid-suv': midSUVs,
                'large-suv': largeSUVs
            },
            recentRegistrations: recentRegistrations.length,
            revenueData,
            activityLog
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /cleaners
router.get('/cleaners', async (req, res) => {
    try {
        const cleaners = await User.find({ role: 'cleaner' });
        res.json(cleaners);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /cleaners
router.post('/cleaners', validate(registerSchema), async (req, res) => {
    try {
        const { name, username, email, password, phone, buildingAssigned } = req.body;

        // Hash password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const newCleaner = new User({
            name,
            username,
            email,
            password: hashedPassword,
            phone,
            buildingAssigned,
            role: 'cleaner'
        });
        await newCleaner.save();

        // Log activity
        await logActivity('cleaner_added', `New Cleaner Added: ${name}`, {
            userId: newCleaner._id,
            buildingName: buildingAssigned
        });

        res.status(201).json(newCleaner);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});


// PUT /cleaners/:id
router.put('/cleaners/:id', validate(registerBaseSchema.partial()), async (req, res) => {
    try {
        const { name, username, email, phone, buildingAssigned, password } = req.body;
        const updates = { name, username, email, phone, buildingAssigned };

        if (password && password.trim()) {
            const saltRounds = 10;
            updates.password = await bcrypt.hash(password, saltRounds);
        }

        const cleaner = await User.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true }
        );

        if (!cleaner) {
            return res.status(404).json({ message: 'Cleaner not found' });
        }

        await logActivity('cleaner_updated', `Cleaner Updated: ${cleaner.name}`, {
            userId: cleaner._id,
            buildingName: cleaner.buildingAssigned
        });

        res.json(cleaner);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /developers
router.get('/developers', async (req, res) => {
    try {
        const developers = await User.find({ role: 'developer' }).lean();
        const developerIds = developers.map(d => d._id);
        const buildings = await Building.find({ developerId: { $in: developerIds } }).sort({ name: 1 }).lean();
        const buildingsByDeveloper = new Map();

        buildings.forEach((building) => {
            const developerId = building.developerId?.toString();
            if (!developerId) {
                return;
            }

            const developerBuildings = buildingsByDeveloper.get(developerId) || [];
            developerBuildings.push({
                _id: building._id,
                name: building.name
            });
            buildingsByDeveloper.set(developerId, developerBuildings);
        });

        const developersWithBuildings = developers.map(dev => {
            const assignedBuildings = buildingsByDeveloper.get(dev._id.toString()) || [];
            const assignedBuildingNames = assignedBuildings.map((building) => building.name);
            return {
                ...dev,
                assignedBuildings,
                buildingIds: assignedBuildings.map((building) => building._id),
                assignedBuilding: assignedBuildingNames.length ? assignedBuildingNames.join(', ') : null,
                buildingId: assignedBuildings[0]?._id || null
            };
        });

        res.json(developersWithBuildings);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /developers
router.post('/developers', validate(registerSchema), async (req, res) => {
    try {
        const { name, username, email, password, phone } = req.body;
        const buildingIds = normalizeDeveloperBuildingIds(req.body);
        const buildingIdsError = await getBuildingIdsValidationError(buildingIds);

        if (buildingIdsError) {
            return res.status(400).json({ message: buildingIdsError });
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const newDeveloper = new User({
            name,
            username,
            email,
            password: hashedPassword,
            phone,
            role: 'developer'
        });
        await newDeveloper.save();

        if (buildingIds.length) {
            await assignBuildingsToDeveloper(newDeveloper._id, buildingIds);
        }

        await logActivity('developer_added', `New Developer Added: ${name}`, {
            userId: newDeveloper._id
        });

        res.status(201).json(newDeveloper);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PUT /developers/:id
router.put('/developers/:id', validate(registerBaseSchema.partial()), async (req, res) => {
    try {
        const { name, username, email, phone, password } = req.body;
        const buildingAssignmentProvided = hasDeveloperBuildingAssignment(req.body);
        const buildingIds = normalizeDeveloperBuildingIds(req.body);
        const updates = { name, username, email, phone };

        if (password && password.trim()) {
            const saltRounds = 10;
            updates.password = await bcrypt.hash(password, saltRounds);
        }

        const existingDeveloper = await User.findById(req.params.id);
        if (!existingDeveloper) {
            return res.status(404).json({ message: 'Developer not found' });
        }

        if (buildingAssignmentProvided) {
            const buildingIdsError = await getBuildingIdsValidationError(buildingIds, existingDeveloper._id);

            if (buildingIdsError) {
                return res.status(400).json({ message: buildingIdsError });
            }
        }

        const developer = await User.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true }
        );

        if (buildingAssignmentProvided) {
            await assignBuildingsToDeveloper(existingDeveloper._id, buildingIds);
        }

        await logActivity('developer_updated', `Developer Updated: ${developer.name}`, {
            userId: developer._id
        });

        res.json(developer);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// DELETE /developers/:id
router.delete('/developers/:id', async (req, res) => {
    try {
        const developer = await User.findByIdAndDelete(req.params.id);
        if (!developer) return res.status(404).json({ message: 'Developer not found' });

        // Unset developerId in Building model
        await Building.updateMany({ developerId: developer._id }, { $unset: { developerId: "" } });

        await logActivity('developer_deleted', `Developer Removed: ${developer.name}`, {
            userId: developer._id
        });

        res.json({ message: 'Developer removed successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /customers
router.get('/customers', async (req, res) => {
    try {
        const customers = await User.find({ role: 'client' })
            .select('-password -secretAnswer -secretQuestion')
            .lean();

        // Populate subscription details manually or via virtuals if set up
        // Since we separated models, we need to fetch subscriptions
        const customerIds = customers.map(c => c._id);
        const subscriptions = await Subscription.find({ userId: { $in: customerIds } }).sort({ createdAt: -1 }).lean();
        const cars = await Car.find({ clientId: { $in: customerIds } }).sort({ createdAt: -1 }).lean();

        const carById = new Map();
        const carsByUser = new Map();
        cars.forEach((car) => {
            carById.set(car._id.toString(), car);
            const key = car.clientId.toString();
            const list = carsByUser.get(key) || [];
            list.push(car);
            carsByUser.set(key, list);
        });

        const customersWithSub = customers.map(customer => {
            const userIdStr = customer._id.toString();
            const userSubs = subscriptions.filter(s => s.userId.toString() === userIdStr);

            const carsForUser = (carsByUser.get(userIdStr) || []).map(car => {
                const carSub = userSubs.find(s => s.carId && s.carId.toString() === car._id.toString());
                const photoUrl = resolveCarPhotoUrl(req, car?.photo);
                return {
                    ...car,
                    photoUrl,
                    subscription: carSub || null,
                };
            });

            const primaryCar = carsForUser[0] || null;
            const primarySub = userSubs.find(s => ['active', 'on_hold'].includes(s.status)) || userSubs[0] || null;
            const carPhotoUrl = primaryCar?.photoUrl || null;
            const { canDeleteAccount, deleteBlockedReason } = getCustomerDeleteState(carsForUser, userSubs);

            return {
                ...sanitizeCustomerRecord(customer),
                subscription: primarySub,
                carPhotoUrl,
                cars: carsForUser,
                canDeleteAccount,
                deleteBlockedReason,
                primaryCarSummary: primaryCar
                    ? {
                        make: primaryCar.make,
                        model: primaryCar.model,
                        type: primaryCar.type,
                        licensePlate: primaryCar.licensePlate,
                        color: primaryCar.color,
                        parkingSlot: primaryCar.parkingSlot,
                    }
                    : null,
            };
        });

        res.json(customersWithSub);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PUT /customers/:id/profile
router.put('/customers/:id/profile', async (req, res) => {
    try {
        const { id } = req.params;
        const nextPassword = String(req.body?.password || '').trim();

        if (!Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid customer id' });
        }

        if (!nextPassword) {
            return res.status(400).json({ success: false, message: 'Password is required' });
        }

        if (nextPassword.length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        }

        const customer = await User.findOne({ _id: id, role: 'client' });
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Customer not found' });
        }

        const saltRounds = 10;
        customer.password = await bcrypt.hash(nextPassword, saltRounds);
        await customer.save();

        res.json({
            success: true,
            message: 'Customer password updated successfully',
            customer: sanitizeCustomerRecord(customer)
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /customers/:id/subscription
router.put('/customers/:id/subscription', async (req, res) => {
    try {
        const requestedStatus = normalizeAdminSubscriptionStatus(req.body?.status);
        const { carId } = req.body || {};
        const userId = req.params.id;

        if (!Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: 'Invalid customer id' });
        }

        if (carId && !Types.ObjectId.isValid(carId)) {
            return res.status(400).json({ success: false, message: 'Invalid car id' });
        }

        if (!requestedStatus) {
            return res.json({ success: false, message: 'Invalid status' });
        }

        let subscription = null;
        if (carId) {
            subscription = await Subscription.findOne({ userId, carId }).sort({ createdAt: -1 });
        }

        if (!subscription) {
            subscription = await Subscription.findOne({ userId, status: { $in: ['active', 'on_hold'] } }).sort({ createdAt: -1 });
        }

        if (!subscription) {
            subscription = await Subscription.findOne({ userId }).sort({ createdAt: -1 });
        }

        if (!subscription) {
            return res.json({ success: false, message: 'No subscription found for this user' });
        }

        if (!stripe || !subscription.stripeSubscriptionId) {
            return res.json({ success: false, message: 'Stripe subscription not configured. Status unchanged.' });
        }

        if (!Array.isArray(subscription.statusHistory)) {
            subscription.statusHistory = [];
        }

        let stripeSubscription = null;
        try {
            stripeSubscription = await withStripeTimeout(
                stripe.subscriptions.retrieve(subscription.stripeSubscriptionId),
                'Stripe request timed out while retrieving subscription. Status unchanged.'
            );
        } catch (e) {
            console.error('Stripe retrieve failed:', e.message);
            const stripeMessage = e?.raw?.message || e?.message || 'Stripe retrieve failed. Status unchanged.';
            return res.json({ success: false, message: stripeMessage });
        }

        const stripeStatus = String(stripeSubscription?.status || '').toLowerCase();
        const currentLocalStatus = resolveLocalStatusFromStripe(stripeSubscription);
        if (currentLocalStatus === 'cancelled') {
            if (subscription.status !== 'cancelled') {
                subscription.status = 'cancelled';
                subscription.endDate = new Date();
                subscription.statusHistory.push({ status: 'cancelled', action: 'stripe_cancelled_sync' });
                await subscription.save();
            }

            const alreadyCancelledMessage = 'Subscription already cancelled on Stripe.';
            if (requestedStatus === 'cancelled') {
                return res.json({ success: true, message: alreadyCancelledMessage, subscription });
            }

            return res.json({
                success: false,
                message: `${alreadyCancelledMessage} Create a new subscription to reactivate.`,
                subscription
            });
        }

        if (requestedStatus === currentLocalStatus) {
            subscription.status = currentLocalStatus;
            if (stripeSubscription?.current_period_start) {
                subscription.startDate = new Date(stripeSubscription.current_period_start * 1000);
            }
            if (stripeSubscription?.current_period_end) {
                subscription.endDate = new Date(stripeSubscription.current_period_end * 1000);
            }
            subscription.statusHistory.push({ status: currentLocalStatus, action: 'admin_sync_noop' });
            await subscription.save();
            return res.json({ success: true, message: 'Subscription already in requested state', subscription });
        }

        const stripePaused = Boolean(stripeSubscription?.pause_collection);
        let updatedStripeSubscription = stripeSubscription;

        try {
            if (requestedStatus === 'cancelled') {
                if (stripeStatus !== 'canceled' && stripeStatus !== 'cancelled') {
                    updatedStripeSubscription = await withStripeTimeout(
                        stripe.subscriptions.cancel(subscription.stripeSubscriptionId),
                        'Stripe request timed out while cancelling subscription. Status unchanged.'
                    );
                }
            } else if (requestedStatus === 'on_hold') {
                if (!stripePaused) {
                    updatedStripeSubscription = await withStripeTimeout(
                        stripe.subscriptions.update(subscription.stripeSubscriptionId, {
                            pause_collection: { behavior: 'void' }
                        }),
                        'Stripe request timed out while putting subscription on hold. Status unchanged.'
                    );
                }
            } else if (requestedStatus === 'active') {
                if (stripePaused) {
                    updatedStripeSubscription = await withStripeTimeout(
                        stripe.subscriptions.update(subscription.stripeSubscriptionId, {
                            pause_collection: null
                        }),
                        'Stripe request timed out while reactivating subscription. Status unchanged.'
                    );
                }
            }
        } catch (e) {
            console.error('Stripe update failed:', e.message);
            const stripeMessage = e?.raw?.message || e?.message || 'Stripe update failed. Status unchanged.';
            const normalizedMessage = String(stripeMessage).toLowerCase();
            if (normalizedMessage.includes('canceled subscription can only update')) {
                if (subscription.status !== 'cancelled') {
                    subscription.status = 'cancelled';
                    subscription.endDate = new Date();
                    subscription.statusHistory.push({ status: 'cancelled', action: 'stripe_cancelled_sync' });
                    await subscription.save();
                }
                return res.json({
                    success: false,
                    message: 'Subscription already cancelled on Stripe. Create a new subscription to reactivate.',
                    subscription
                });
            }
            return res.json({ success: false, message: stripeMessage });
        }

        const nextLocalStatus = resolveLocalStatusFromStripe(updatedStripeSubscription);

        subscription.status = nextLocalStatus;

        if (updatedStripeSubscription?.current_period_start) {
            subscription.startDate = new Date(updatedStripeSubscription.current_period_start * 1000);
        }
        if (updatedStripeSubscription?.current_period_end) {
            subscription.endDate = new Date(updatedStripeSubscription.current_period_end * 1000);
        }
        if (nextLocalStatus === 'cancelled') {
            subscription.endDate = new Date();
        }

        const actionByStatus = {
            active: 'admin_activate',
            on_hold: 'admin_hold',
            cancelled: 'admin_cancel',
            inactive: 'stripe_sync'
        };
        subscription.statusHistory.push({ status: nextLocalStatus, action: actionByStatus[nextLocalStatus] || 'admin_update' });

        await subscription.save();
        res.json({ success: true, message: 'Subscription status updated', subscription });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// DELETE /customers/:id
router.delete('/customers/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid customer id' });
        }

        const customer = await User.findOne({ _id: id, role: 'client' }).select('name');
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Customer not found' });
        }

        const [cars, subscriptions] = await Promise.all([
            Car.find({ clientId: id }).lean(),
            Subscription.find({ userId: id }).sort({ createdAt: -1 }).lean(),
        ]);

        const { canDeleteAccount, deleteBlockedReason } = getCustomerDeleteState(cars, subscriptions);
        if (!canDeleteAccount) {
            return res.status(400).json({
                success: false,
                message: deleteBlockedReason || 'Customer cannot be deleted yet.'
            });
        }

        const carIds = cars.map((car) => car._id);

        await Schedule.deleteMany({ clientId: id });
        await WashRecord.deleteMany({
            $or: [
                { clientId: id },
                ...(carIds.length ? [{ carId: { $in: carIds } }] : [])
            ]
        });
        await Review.deleteMany({ clientId: id });
        await Contact.deleteMany({ userId: id });
        await Subscription.deleteMany({ userId: id });
        await Car.deleteMany({ clientId: id });
        await User.deleteOne({ _id: id, role: 'client' });

        res.json({ success: true, message: 'Customer deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// DELETE /subscriptions/:id (only allowed for already-cancelled subs)
router.delete('/subscriptions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!Types.ObjectId.isValid(id)) {
            return res.json({ success: false, message: 'Invalid subscription id' });
        }

        const subscription = await Subscription.findById(id);
        if (!subscription) {
            return res.json({ success: false, message: 'Subscription not found' });
        }

        if (subscription.status !== 'cancelled') {
            return res.json({ success: false, message: 'Only cancelled subscriptions can be deleted' });
        }

        await Subscription.deleteOne({ _id: id });
        res.json({ success: true, message: 'Subscription deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /subscriptions
router.get('/subscriptions', async (req, res) => {
    try {
        const subscriptions = await Subscription.find({ status: 'active' }).populate('userId');
        res.json(subscriptions);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /subscriptions/stripe-sync - Stripe subscriptions that have no matching local record.
// Covers subscriptions an admin created directly in the Stripe dashboard instead of through the app.
router.get('/subscriptions/stripe-sync', async (req, res) => {
    try {
        if (!stripe) {
            return res.json({
                success: false,
                message: 'Stripe is not configured on the server.',
                unmatched: [],
                unmatchedCount: 0,
                totalStripeSubscriptions: 0
            });
        }

        const localSubs = await Subscription.find({ stripeSubscriptionId: { $ne: null } })
            .select('stripeSubscriptionId')
            .lean();
        const localIds = new Set(localSubs.map((s) => s.stripeSubscriptionId));

        const plans = await SubscriptionPlan.find({ stripePriceId: { $ne: null } }).lean();
        const planByPriceId = new Map(plans.map((p) => [p.stripePriceId, p]));

        const unmatched = [];
        let totalStripeSubscriptions = 0;

        const stripeSubscriptions = await withStripeTimeout(
            (async () => {
                const list = [];
                const iterator = stripe.subscriptions.list({
                    limit: 100,
                    status: 'all',
                    expand: ['data.customer', 'data.items.data.price']
                });
                for await (const sub of iterator) {
                    list.push(sub);
                }
                return list;
            })(),
            'Stripe request timed out while listing subscriptions.'
        );

        stripeSubscriptions.forEach((sub) => {
            totalStripeSubscriptions += 1;
            if (localIds.has(sub.id)) return;

            const price = sub.items?.data?.[0]?.price || null;
            const customer = sub.customer && typeof sub.customer === 'object' ? sub.customer : null;
            const suggestedPlan = price?.id ? planByPriceId.get(price.id) : null;

            unmatched.push({
                stripeSubscriptionId: sub.id,
                status: sub.status,
                customerId: customer?.id || (typeof sub.customer === 'string' ? sub.customer : null),
                customerEmail: customer?.email || null,
                customerName: customer?.name || null,
                priceId: price?.id || null,
                amount: typeof price?.unit_amount === 'number' ? price.unit_amount / 100 : null,
                currency: price?.currency || null,
                currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
                created: sub.created ? new Date(sub.created * 1000) : null,
                suggestedPlanId: suggestedPlan ? String(suggestedPlan._id) : null,
                suggestedPlanLabel: suggestedPlan ? `${suggestedPlan.carType} - ${suggestedPlan.planType}` : null
            });
        });

        res.json({
            success: true,
            unmatched,
            unmatchedCount: unmatched.length,
            totalStripeSubscriptions
        });
    } catch (error) {
        console.error('Stripe subscriptions sync failed:', error.message);
        const stripeMessage = error?.raw?.message || error.message;
        res.status(500).json({ success: false, message: stripeMessage, unmatched: [], unmatchedCount: 0, totalStripeSubscriptions: 0 });
    }
});

// POST /subscriptions/assign - link an unmatched Stripe subscription to a customer's car
router.post('/subscriptions/assign', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({ success: false, message: 'Stripe is not configured on the server.' });
        }

        const { stripeSubscriptionId, userId, carId, planId } = req.body || {};

        if (!stripeSubscriptionId || !userId || !carId || !planId) {
            return res.status(400).json({ success: false, message: 'stripeSubscriptionId, userId, carId and planId are all required.' });
        }

        if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(carId) || !Types.ObjectId.isValid(planId)) {
            return res.status(400).json({ success: false, message: 'Invalid userId, carId or planId.' });
        }

        const existing = await Subscription.findOne({ stripeSubscriptionId });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'This Stripe subscription is already linked to a subscription record.',
                subscription: existing
            });
        }

        const [user, car, plan] = await Promise.all([
            User.findOne({ _id: userId, role: 'client' }),
            Car.findById(carId),
            SubscriptionPlan.findById(planId)
        ]);

        if (!user) return res.status(404).json({ success: false, message: 'Customer not found.' });
        if (!car) return res.status(404).json({ success: false, message: 'Car not found.' });
        if (car.clientId.toString() !== userId.toString()) {
            return res.status(400).json({ success: false, message: 'That car does not belong to the selected customer.' });
        }
        if (!plan) return res.status(404).json({ success: false, message: 'Subscription plan not found.' });

        let stripeSub;
        try {
            stripeSub = await withStripeTimeout(
                stripe.subscriptions.retrieve(stripeSubscriptionId, { expand: ['customer'] }),
                'Stripe request timed out while retrieving subscription.'
            );
        } catch (e) {
            const stripeMessage = e?.raw?.message || e?.message || 'Could not retrieve this subscription from Stripe.';
            return res.status(404).json({ success: false, message: stripeMessage });
        }

        const localStatus = resolveLocalStatusFromStripe(stripeSub);
        if (localStatus === 'cancelled') {
            return res.status(409).json({ success: false, message: 'This Stripe subscription is already cancelled and cannot be assigned.' });
        }

        // Backfill the customer's Stripe id if it was never set - only when it isn't already
        // pointing somewhere else, so we never overwrite an existing, unrelated link.
        const stripeCustomerId = typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id;
        if (stripeCustomerId && !user.stripeCustomerId) {
            user.stripeCustomerId = stripeCustomerId;
            await user.save();
        }

        // Mirror the "one active/on_hold subscription per car" rule enforced on the normal subscribe flow.
        await Subscription.updateMany(
            { carId, status: { $in: ['active', 'on_hold'] } },
            {
                status: 'cancelled',
                endDate: new Date(),
                $push: { statusHistory: { status: 'cancelled', action: 'system_cancel_new_sub', timestamp: new Date() } }
            }
        );

        const newSubscription = new Subscription({
            userId,
            carId,
            planId: String(planId),
            status: localStatus,
            startDate: stripeSub.current_period_start ? new Date(stripeSub.current_period_start * 1000) : new Date(),
            endDate: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000) : undefined,
            stripeSubscriptionId: stripeSub.id,
            planDetails: {
                type: plan.planType,
                carType: plan.carType,
                price: plan.price,
                features: plan.features,
                washFrequency: plan.washFrequency
            },
            statusHistory: [{ status: localStatus, action: 'admin_assign_existing_stripe_subscription', timestamp: new Date() }]
        });

        await newSubscription.save();

        await logActivity(
            'subscription_assigned',
            `Admin linked existing Stripe subscription ${stripeSub.id} to ${user.name}'s ${car.make} ${car.model}`,
            { userId, carId, stripeSubscriptionId: stripeSub.id }
        );

        res.status(201).json({ success: true, message: 'Subscription linked successfully.', subscription: newSubscription });
    } catch (error) {
        console.error('Failed to assign Stripe subscription:', error.message);
        const stripeMessage = error?.raw?.message || error.message;
        res.status(500).json({ success: false, message: stripeMessage });
    }
});

// DELETE /cleaners/:id
router.delete('/cleaners/:id', async (req, res) => {
    try {
        const cleaner = await User.findByIdAndDelete(req.params.id);
        if (!cleaner) return res.status(404).json({ message: 'Cleaner not found' });
        res.json({ message: 'Cleaner removed successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /subscription-plans
router.get('/subscription-plans', async (req, res) => {
    try {
        const plans = await SubscriptionPlan.find().sort({ carType: 1, planType: 1 });
        res.json(plans);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /subscription-plans
router.post('/subscription-plans', async (req, res) => {
    try {
        const { carType, planType, price, features } = req.body;

        // Check if a plan already exists for this carType and planType
        let plan = await SubscriptionPlan.findOne({ carType, planType });

        if (plan) {
            // Update existing plan
            plan.price = price;
            plan.features = features;
            plan = await plan.save();
        } else {
            // Create new plan
            plan = new SubscriptionPlan({
                carType,
                planType,
                price,
                features
            });
            await plan.save();
        }

        try {
            plan = await ensurePlanStripePricing(plan);
        } catch (e) {
            console.error('Stripe price/product sync failed for plan:', e.message);
        }

        res.status(201).json(plan);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PUT /subscription-plans/:id
router.put('/subscription-plans/:id', async (req, res) => {
    try {
        const { price, features } = req.body;
        let plan = await SubscriptionPlan.findByIdAndUpdate(
            req.params.id,
            { price, features, updatedAt: Date.now() },
            { new: true }
        );
        if (!plan) {
            return res.status(404).json({ message: 'Plan not found' });
        }

        try {
            plan = await ensurePlanStripePricing(plan);
        } catch (e) {
            console.error('Stripe price/product sync failed for plan:', e.message);
        }

        res.json(plan);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// DELETE /subscription-plans/:id
router.delete('/subscription-plans/:id', async (req, res) => {
    try {
        const plan = await SubscriptionPlan.findByIdAndDelete(req.params.id);
        if (!plan) {
            return res.status(404).json({ message: 'Plan not found' });
        }
        res.json({ message: 'Plan deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /activities - Fetch recent activity logs
router.get('/activities', async (req, res) => {
    try {
        const activities = await ActivityLog.find()
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();
        res.json(activities);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /notifications - Fetch unread notifications
router.get('/notifications', async (req, res) => {
    try {
        const Notification = require('../models/Notification');
        const notifications = await Notification.find({ recipientRole: 'admin', read: false })
            .sort({ createdAt: -1 });
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PUT /notifications/:id/read - Mark notification as read
router.put('/notifications/:id/read', async (req, res) => {
    try {
        const Notification = require('../models/Notification');
        await Notification.findByIdAndUpdate(req.params.id, { read: true });
        res.json({ message: 'Notification marked as read' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /reviews - Fetch all reviews with client details
router.get('/reviews', async (req, res) => {
    try {
        const reviews = await Review.find()
            .populate('clientId', 'name email phone')
            .sort({ createdAt: -1 })
            .lean();

        res.json(reviews);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /contacts - Fetch all contact messages with user details
router.get('/contacts', async (req, res) => {
    try {
        const contacts = await Contact.find()
            .populate('userId', 'name email phone')
            .sort({ createdAt: -1 })
            .lean();

        res.json(contacts);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /building-car-types/:buildingId - Fetch car types for a specific building
router.get('/building-car-types/:buildingId', async (req, res) => {
    try {
        const { buildingId } = req.params;

        // Find all users associated with the building
        let users;
        if (buildingId === 'all') {
            users = await User.find({ role: 'client' });
        } else {
            const building = await Building.findById(buildingId);
            if (!building) {
                return res.status(404).json({ message: 'Building not found' });
            }
            users = await User.find({ buildingName: building.name, role: 'client' });
        }

        // Get all car IDs for these users
        const userIds = users.map(user => user._id);

        // Count cars by type
        const hatchbacks = await Car.countDocuments({
            clientId: { $in: userIds },
            type: { $in: ['hatchback', 'hatchback-small'] }
        });

        const sedans = await Car.countDocuments({
            clientId: { $in: userIds },
            type: 'sedan'
        });

        const midSUVs = await Car.countDocuments({
            clientId: { $in: userIds },
            type: { $in: ['mid-suv', 'sedan/mid-SUV'] }
        });

        const largeSUVs = await Car.countDocuments({
            clientId: { $in: userIds },
            type: { $in: ['large-suv', 'SUV-large'] }
        });

        res.json({
            hatchback: hatchbacks,
            sedan: sedans,
            'mid-suv': midSUVs,
            'large-suv': largeSUVs
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
