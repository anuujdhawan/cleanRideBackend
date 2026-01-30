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
const Building = require('../models/Building');
const { logActivity } = require('../utils/activityLogger');
const { resolveCarPhotoUrl } = require('../utils/carPhotoUrl');
const bcrypt = require('bcrypt');

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

const toStripeUnitAmount = (amount) => {
    const parsed = typeof amount === 'number' ? amount : Number(amount);
    return Math.round((Number.isFinite(parsed) ? parsed : 0) * 100);
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

        // Calculate Real Revenue Data
        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const pastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const pastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

        // Current Month Revenue (Sum of prices of subscriptions created this month)
        const currentMonthSubs = await Subscription.find({
            createdAt: { $gte: currentMonthStart },
            ...(clientIds ? { userId: { $in: clientIds } } : {})
        });
        const currentMonthRevenue = currentMonthSubs.reduce((sum, sub) => sum + (sub.planDetails?.price || 0), 0);

        // Past Month Revenue (Sum of prices of subscriptions created last month)
        const pastMonthSubs = await Subscription.find({
            createdAt: { $gte: pastMonthStart, $lte: pastMonthEnd },
            ...(clientIds ? { userId: { $in: clientIds } } : {})
        });
        const pastMonthRevenue = pastMonthSubs.reduce((sum, sub) => sum + (sub.planDetails?.price || 0), 0);

        const revenueData = {
            currentMonth: currentMonthRevenue,
            pastMonth: pastMonthRevenue,
            labels: ["Current Month", "Past Month"],
            datasets: [
                {
                    data: [currentMonthRevenue, pastMonthRevenue]
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
router.post('/cleaners', async (req, res) => {
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
router.put('/cleaners/:id', async (req, res) => {
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
        const developers = await User.find({ role: 'developer' });
        res.json(developers);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /developers
router.post('/developers', async (req, res) => {
    try {
        const { name, username, email, password, phone } = req.body;

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

        await logActivity('developer_added', `New Developer Added: ${name}`, {
            userId: newDeveloper._id
        });

        res.status(201).json(newDeveloper);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PUT /developers/:id
router.put('/developers/:id', async (req, res) => {
    try {
        const { name, username, email, phone, password } = req.body;
        const updates = { name, username, email, phone };

        if (password && password.trim()) {
            const saltRounds = 10;
            updates.password = await bcrypt.hash(password, saltRounds);
        }

        const developer = await User.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true }
        );
        if (!developer) {
            return res.status(404).json({ message: 'Developer not found' });
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
        const customers = await User.find({ role: 'client' }).lean();

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

            return {
                ...customer,
                subscription: primarySub,
                carPhotoUrl,
                cars: carsForUser,
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

// PUT /customers/:id/subscription
router.put('/customers/:id/subscription', async (req, res) => {
    try {
        const { status, carId } = req.body; // 'active', 'on_hold', 'cancelled'
        const userId = req.params.id;

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

        let stripeSubscription = null;
        try {
            stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
        } catch (e) {
            console.error('Stripe retrieve failed:', e.message);
            const stripeMessage = e?.raw?.message || e?.message || 'Stripe retrieve failed. Status unchanged.';
            return res.json({ success: false, message: stripeMessage });
        }

        const stripeStatus = String(stripeSubscription?.status || '').toLowerCase();
        if (stripeStatus === 'canceled' || stripeStatus === 'cancelled') {
            if (subscription.status !== 'cancelled') {
                subscription.status = 'cancelled';
                subscription.endDate = new Date();
                subscription.statusHistory.push({ status: 'cancelled', action: 'stripe_cancelled_sync' });
                await subscription.save();
            }

            const alreadyCancelledMessage = 'Subscription already cancelled on Stripe.';
            if (status === 'cancelled') {
                return res.json({ success: true, message: alreadyCancelledMessage, subscription });
            }

            return res.json({
                success: false,
                message: `${alreadyCancelledMessage} Create a new subscription to reactivate.`,
                subscription
            });
        }

        if (!['active', 'on_hold', 'cancelled'].includes(status)) {
            return res.json({ success: false, message: 'Invalid status' });
        }

        const stripePaused = Boolean(stripeSubscription?.pause_collection);
        let updatedStripeSubscription = stripeSubscription;

        try {
            if (status === 'cancelled') {
                if (stripeStatus !== 'canceled' && stripeStatus !== 'cancelled') {
                    updatedStripeSubscription = await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
                }
            } else if (status === 'on_hold') {
                if (!stripePaused) {
                    updatedStripeSubscription = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
                        pause_collection: { behavior: 'void' }
                    });
                }
            } else if (status === 'active') {
                if (stripePaused) {
                    updatedStripeSubscription = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
                        pause_collection: null
                    });
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

        const updatedStripeStatus = String(updatedStripeSubscription?.status || '').toLowerCase();
        const updatedPaused = Boolean(updatedStripeSubscription?.pause_collection);

        let nextLocalStatus = 'inactive';
        if (updatedStripeStatus === 'canceled' || updatedStripeStatus === 'cancelled') {
            nextLocalStatus = 'cancelled';
        } else if (updatedStripeStatus === 'active' || updatedStripeStatus === 'trialing') {
            nextLocalStatus = updatedPaused ? 'on_hold' : 'active';
        }

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
