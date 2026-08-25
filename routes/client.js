const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();

// Load env vars even if the server is started from the project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');
const Car = require('../models/Car');
const Schedule = require('../models/Schedule');
const Review = require('../models/Review');
const Contact = require('../models/Contact');
const Subscription = require('../models/Subscription');
const WashRecord = require('../models/WashRecord');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const bcrypt = require('bcrypt');
const { resolveCarPhotoUrl, isAbsolutePhotoValue } = require('../utils/carPhotoUrl');
const { sendExpoPushNotifications } = require('../utils/expoPush');
const { Expo } = require('expo-server-sdk');
const validate = require('../middleware/validate');
const { updateCarSchema } = require('../schemas');

let stripe = null;
const stripeKey = process.env.STRIPE_SECRET_KEY;
const STRIPE_API_VERSION = '2023-10-16';

if (stripeKey && stripeKey.startsWith('sk_')) {
    stripe = require('stripe')(stripeKey, { apiVersion: STRIPE_API_VERSION });
} else {
    console.warn('Stripe key is missing or invalid. Subscription routes will require Stripe to create/manage subscriptions.');
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

const buildCarPhotoUrl = (req, photo) => resolveCarPhotoUrl(req, photo);
const carPhotoDir = path.join(__dirname, '..', 'public', 'car-photos');

const removeCarPhotoFile = async (photo) => {
    if (!photo || isAbsolutePhotoValue(photo)) return;
    const safeName = path.basename(String(photo));
    if (!safeName) return;
    const filePath = path.join(carPhotoDir, safeName);
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn('Failed to remove car photo file:', error.message || error);
        }
    }
};

// --- Support for PUT /cars/:carId (edit car) below. Kept local to this file
// rather than shared with auth.js's create-car helpers, to avoid touching that
// (live, high-traffic) file for this addition.

const normalizeCarType = (value) => {
    if (!value) return 'sedan';
    const normalized = String(value).toLowerCase().replace(/_/g, '-');
    if (normalized.includes('hatch')) return 'hatchback';
    if (normalized.includes('large') && normalized.includes('suv')) return 'large-suv';
    if (normalized.includes('mid') && normalized.includes('suv')) return 'mid-suv';
    if (normalized.includes('suv')) return 'mid-suv';
    if (normalized.includes('sedan')) return 'sedan';
    return 'sedan';
};

const useMemoryCarPhotoStorage = Boolean(process.env.VERCEL) || process.env.CAR_PHOTO_STORAGE === 'memory';

const ensureCarPhotoDir = () => {
    if (useMemoryCarPhotoStorage) return;
    fs.mkdirSync(carPhotoDir, { recursive: true });
};

const carPhotoStorage = useMemoryCarPhotoStorage
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => {
            ensureCarPhotoDir();
            cb(null, carPhotoDir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
            const unique = crypto.randomBytes(16).toString('hex');
            cb(null, `${unique}${ext}`);
        }
    });

const carPhotoUpload = multer({
    storage: carPhotoStorage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    },
    limits: { fileSize: 5 * 1024 * 1024 }
});

const maybeUploadCarPhoto = (req, res, next) => {
    if (req.is('multipart')) {
        return carPhotoUpload.single('carPhoto')(req, res, (err) => {
            if (err) {
                const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
                return res.status(status).json({ message: err.message });
            }
            return next();
        });
    }
    next();
};

const resolveCarPhotoValue = (file) => {
    if (!file) return null;
    if (file.buffer) {
        const mimeType = file.mimetype || 'image/jpeg';
        const encoded = file.buffer.toString('base64');
        return `data:${mimeType};base64,${encoded}`;
    }
    return file.filename || null;
};

// Mirrors the subscription lookup already inline in DELETE /cars/:carId below
// (including its legacy fallback for pre-multi-car subscriptions that never
// recorded a carId) so the edit-car guard can't be bypassed by that same edge
// case. Deliberately not shared with the DELETE route's own copy, so that
// route is left byte-for-byte untouched.
const findActiveSubscriptionForCar = async (userId, carId) => {
    let subscription = await Subscription.findOne({ userId, carId })
        .sort({ createdAt: -1 })
        .lean();

    if (!subscription) {
        const carCount = await Car.countDocuments({ clientId: userId });
        if (carCount === 1) {
            subscription = await Subscription.findOne({
                userId,
                status: { $in: ['active', 'on_hold'] },
                $or: [{ carId: { $exists: false } }, { carId: null }]
            }).sort({ createdAt: -1 }).lean();
        }
    }

    return subscription;
};

// Middleware to verify token
const verifyToken = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

    try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key', { ignoreExpiration: true });
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
    } catch (ex) {
        res.status(400).json({ message: 'Invalid token.' });
    }
};

// GET /dashboard
router.get('/dashboard', async (req, res) => {
    try {
        const { userId, carId } = req.query; // Assuming userId is passed as query param for now
        if (!userId) return res.status(400).json({ message: 'User ID required' });

        let car = null;
        let resolvedCarId = carId;

        if (carId) {
            car = await Car.findOne({ _id: carId, clientId: userId });
        }
        if (!car) {
            car = await Car.findOne({ clientId: userId }).sort({ createdAt: -1 });
            resolvedCarId = car?._id;
        }
        const user = await User.findById(userId);

        // Fetch active or on_hold subscription
        const subscriptionQuery = {
            userId: userId,
            status: { $in: ['active', 'on_hold'] },
            ...(resolvedCarId ? { carId: resolvedCarId } : {})
        };

        let subscription = await Subscription.findOne(subscriptionQuery).sort({ createdAt: -1 });

        if (!subscription && resolvedCarId) {
            const carCount = await Car.countDocuments({ clientId: userId });
            if (carCount === 1) {
                subscription = await Subscription.findOne({
                    userId,
                    status: { $in: ['active', 'on_hold'] },
                    $or: [{ carId: { $exists: false } }, { carId: null }]
                }).sort({ createdAt: -1 });
            }
        }

        // Stripe handles subscription billing/renewal; keep DB as a mirror of Stripe status.

        const scheduleQuery = {
            clientId: userId,
            ...(resolvedCarId ? { carId: resolvedCarId } : {})
        };

        // Find next scheduled wash
        const nextWash = await Schedule.findOne({
            ...scheduleQuery,
            status: 'scheduled',
            scheduledDate: { $gte: new Date() }
        }).sort({ scheduledDate: 1 });

        // Find last wash
        const lastWash = await Schedule.findOne({
            ...scheduleQuery,
            status: 'completed'
        }).sort({ scheduledDate: -1 });

        const carPayload = car ? { ...car.toObject() } : null;
        if (carPayload?.photo) {
            carPayload.photoUrl = buildCarPhotoUrl(req, carPayload.photo);
        }

        res.json({
            car: carPayload,
            subscription,
            nextWash,
            lastWash,
            selectedCarId: resolvedCarId || null
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /monthly-schedule
router.get('/monthly-schedule', async (req, res) => {
    try {
        const { userId, carId, month, year } = req.query;
        if (!userId || !carId) {
            return res.status(400).json({ message: 'userId and carId are required' });
        }

        const monthCandidate = typeof month === 'string' && month.length ? parseInt(month, 10) : NaN;
        const yearCandidate = typeof year === 'string' && year.length ? parseInt(year, 10) : NaN;
        const parsedMonth = Number.isNaN(monthCandidate) ? new Date().getMonth() : Math.max(0, Math.min(11, monthCandidate));
        const parsedYear = Number.isNaN(yearCandidate) ? new Date().getFullYear() : yearCandidate;

        const startOfMonth = new Date(parsedYear, parsedMonth, 1, 0, 0, 0, 0);
        const lastDayOfMonth = new Date(parsedYear, parsedMonth + 1, 0).getDate();
        const endOfMonth = new Date(parsedYear, parsedMonth, lastDayOfMonth, 23, 59, 59, 999);

        const user = await User.findById(userId).lean();
        if (!user) return res.status(404).json({ message: 'User not found' });

        const cars = await Car.find({ clientId: userId }).lean();
        const carById = new Map(cars.map((entry) => [entry._id.toString(), entry]));
        const car = carById.get(carId.toString());
        if (!car) return res.status(404).json({ message: 'Car not found' });
        const carCount = cars.length;

        const subscriptionQuery = {
            userId,
            status: { $in: ['active', 'on_hold'] },
            ...(carId ? { carId } : {})
        };
        let subscription = await Subscription.findOne(subscriptionQuery).sort({ createdAt: -1 });
        if (!subscription && carId) {
            subscription = await Subscription.findOne({ userId, carId }).sort({ createdAt: -1 });
        }
        if (!subscription && carId && carCount === 1) {
            subscription = await Subscription.findOne({
                userId,
                status: { $in: ['active', 'on_hold'] },
                $or: [{ carId: { $exists: false } }, { carId: null }]
            }).sort({ createdAt: -1 });
        }

        const activeStartSource = subscription?.startDate ? new Date(subscription.startDate) : new Date(user.createdAt);
        const activeStartDate = new Date(
            activeStartSource.getFullYear(),
            activeStartSource.getMonth(),
            activeStartSource.getDate()
        );

        const washDaysString = user.washDays || 'Mon,Wed,Fri';
        const subscriptionStatus = subscription?.status || 'inactive';

        const carPayload = { ...car };
        if (carPayload.photo) {
            carPayload.photoUrl = buildCarPhotoUrl(req, carPayload.photo);
        }

        if (!subscription || ['cancelled', 'inactive'].includes(subscriptionStatus)) {
            return res.json({
                car: carPayload,
                washDays: washDaysString,
                entries: [],
                month: parsedMonth,
                year: parsedYear,
                status: subscriptionStatus
            });
        }

        const isOnHold = subscriptionStatus === 'on_hold';
        let holdStartDate = null;
        if (isOnHold) {
            const history = Array.isArray(subscription.statusHistory) ? subscription.statusHistory : [];
            const latestHold = [...history].reverse().find((entry) => entry.status === 'on_hold');
            const holdSource = latestHold?.timestamp ? new Date(latestHold.timestamp) : new Date();
            holdStartDate = new Date(holdSource.getFullYear(), holdSource.getMonth(), holdSource.getDate());
        }

        const washRecordQuery = {
            clientId: userId,
            $or: [
                { washDate: { $gte: startOfMonth, $lte: endOfMonth } },
                { washForDate: { $gte: startOfMonth, $lte: endOfMonth } }
            ]
        };

        const [schedules, washRecords] = await Promise.all([
            Schedule.find({
                clientId: userId,
                carId,
                scheduledDate: { $gte: startOfMonth, $lte: endOfMonth }
            }).lean(),
            WashRecord.find(washRecordQuery).lean()
        ]);

        const toLocalDateKey = (value) => {
            const date = new Date(value);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        const scheduleByDay = new Map();
        schedules.forEach((entry) => {
            const key = toLocalDateKey(entry.scheduledDate);
            scheduleByDay.set(key, entry);
        });

        const washByDay = new Map();
        washRecords.forEach((record) => {
            const keySource = record.washForDate || record.washDate;
            const key = toLocalDateKey(keySource);
            const entry = washByDay.get(key) || { hasCarMatch: false, washTime: null };
            const recordCarId = record.carId ? record.carId.toString() : null;
            let resolvedCarId = recordCarId;
            if (!resolvedCarId) {
                const washDate = new Date(record.washDate);
                const candidates = cars.filter((item) => new Date(item.createdAt) <= washDate);
                if (candidates.length === 1) {
                    resolvedCarId = candidates[0]._id.toString();
                }
            }
            if (resolvedCarId && resolvedCarId === carId.toString()) {
                entry.hasCarMatch = true;
                if (!entry.washTime && record.washTime) {
                    entry.washTime = record.washTime;
                }
            }
            washByDay.set(key, entry);
        });

        const dayNameMap = {
            Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
        };
        const washDays = washDaysString
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);

        const allowedDays = new Set();
        washDays.forEach((day) => {
            const key = dayNameMap[day];
            if (typeof key === 'number') {
                allowedDays.add(key);
            }
        });
        if (!allowedDays.size) {
            allowedDays.add(1);
            allowedDays.add(3);
            allowedDays.add(5);
        }

        const today = new Date();
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        const entries = [];
        for (let day = 1; day <= lastDayOfMonth; day += 1) {
            const currentDate = new Date(parsedYear, parsedMonth, day);
            if (!allowedDays.has(currentDate.getDay())) continue;
            if (currentDate < activeStartDate) continue;
            if (isOnHold && holdStartDate && currentDate > holdStartDate) continue;

            const dateKey = toLocalDateKey(currentDate);
            const schedule = scheduleByDay.get(dateKey);
            const washInfo = washByDay.get(dateKey);
            const hasWash = Boolean(washInfo?.hasCarMatch);
            const scheduleCompleted = schedule && schedule.status === 'completed';
            let status = 'scheduled';

            if (hasWash || scheduleCompleted) {
                status = 'washed';
            } else if (currentDate < todayStart) {
                status = 'pending';
            }

            entries.push({
                date: dateKey,
                displayDate: currentDate.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }),
                dayName: currentDate.toLocaleDateString('en-US', { weekday: 'short' }),
                status,
                scheduledTime: schedule?.startTime || (status === 'washed' ? washInfo?.washTime || null : null)
            });
        }

        res.json({
            car: carPayload,
            washDays: washDaysString,
            entries,
            month: parsedMonth,
            year: parsedYear
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /wash-history
router.get('/wash-history', async (req, res) => {
    try {
        const { userId, carId } = req.query;
        if (!userId) return res.status(400).json({ message: 'User ID required' });

        const cars = await Car.find({ clientId: userId }).lean();
        const carById = new Map(cars.map((car) => [car._id.toString(), car]));

        const normalizedCarId = carId ? carId.toString() : null;
        const query = { clientId: userId };
        if (normalizedCarId) {
            query.$or = [
                { carId: normalizedCarId },
                { carId: { $exists: false } },
                { carId: null }
            ];
        }

        const history = await WashRecord.find(query).sort({ washDate: -1 }).lean();

        const payload = [];
        history.forEach((record) => {
            const recordCarId = record.carId ? record.carId.toString() : null;
            let resolvedCar = recordCarId ? carById.get(recordCarId) : null;

            if (!recordCarId) {
                const washDate = new Date(record.washDate);
                const candidates = cars.filter((item) => new Date(item.createdAt) <= washDate);
                if (candidates.length === 1) {
                    resolvedCar = candidates[0];
                }
            }

            const resolvedCarId = resolvedCar?._id?.toString() || null;
            if (normalizedCarId) {
                const matchesSelected = recordCarId === normalizedCarId || resolvedCarId === normalizedCarId;
                if (!matchesSelected) {
                    return;
                }
            }

            const carPayload = resolvedCar ? { ...resolvedCar } : null;
            if (carPayload?.photo) {
                carPayload.photoUrl = buildCarPhotoUrl(req, carPayload.photo);
            }

            payload.push({
                ...record,
                car: carPayload,
                carId: recordCarId || resolvedCarId || null
            });
        });

        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /history
router.get('/history', async (req, res) => {
    try {
        const { userId, carId } = req.query;
        if (!userId) return res.status(400).json({ message: 'User ID required' });

        const query = { clientId: userId };
        if (carId) {
            query.carId = carId;
        }
        const history = await Schedule.find(query).sort({ scheduledDate: -1 });
        res.json(history);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /cars - list all cars for a client
router.get('/cars', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ message: 'User ID required' });

        const cars = await Car.find({ clientId: userId }).sort({ createdAt: -1 }).lean();
        if (!cars.length) return res.json([]);

        const carIds = cars.map((car) => car._id);
        const subscriptions = await Subscription.find({
            userId,
            carId: { $in: carIds }
        }).sort({ createdAt: -1 }).lean();

        const subscriptionByCar = new Map();
        subscriptions.forEach((sub) => {
            const key = sub.carId?.toString();
            if (key && !subscriptionByCar.has(key)) {
                subscriptionByCar.set(key, sub);
            }
        });

        let fallbackSubscription = null;
        if (cars.length === 1) {
            fallbackSubscription = subscriptions.find((sub) => !sub.carId) || null;
        }

        const payload = cars.map((car) => {
            const subscription = subscriptionByCar.get(car._id.toString()) || fallbackSubscription || null;
            return {
                ...car,
                photoUrl: buildCarPhotoUrl(req, car.photo),
                subscription
            };
        });

        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /cars/:carId - fetch a specific car for a client
router.get('/cars/:carId', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ message: 'User ID required' });

        const car = await Car.findOne({ _id: req.params.carId, clientId: userId }).lean();
        if (!car) return res.status(404).json({ message: 'Car not found' });
        const subscription = await findActiveSubscriptionForCar(userId, car._id);
        res.json({ ...car, photoUrl: buildCarPhotoUrl(req, car.photo), subscription: subscription || null });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// DELETE /cars/:carId - delete a car if subscription is inactive
router.delete('/cars/:carId', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ message: 'User ID required' });

        const car = await Car.findOne({ _id: req.params.carId, clientId: userId });
        if (!car) return res.status(404).json({ message: 'Car not found' });

        let subscription = await Subscription.findOne({ userId, carId: car._id })
            .sort({ createdAt: -1 })
            .lean();

        if (!subscription) {
            const carCount = await Car.countDocuments({ clientId: userId });
            if (carCount === 1) {
                subscription = await Subscription.findOne({
                    userId,
                    status: { $in: ['active', 'on_hold'] },
                    $or: [{ carId: { $exists: false } }, { carId: null }]
                }).sort({ createdAt: -1 }).lean();
            }
        }

        const subscriptionStatus = subscription?.status || 'inactive';
        if (['active', 'on_hold'].includes(subscriptionStatus)) {
            return res.status(400).json({ message: 'Car cannot be deleted while subscription is active' });
        }

        await Car.deleteOne({ _id: car._id });
        await removeCarPhotoFile(car.photo);
        res.json({ message: 'Car deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PUT /cars/:carId - edit an already-registered car's details.
// Ownership is derived from the JWT (never trusted from the request body).
// Car type may not be changed while a subscription for this car is active/on_hold,
// since a subscription's plan pricing is locked in at subscribe-time and never
// reconciled against the car afterward - see findActiveSubscriptionForCar above.
router.put('/cars/:carId', verifyToken, maybeUploadCarPhoto, validate(updateCarSchema), async (req, res) => {
    try {
        const authUserId = req.user?.userId;
        if (!authUserId) {
            return res.status(401).json({ message: 'Invalid token payload' });
        }

        const car = await Car.findById(req.params.carId);
        if (!car) {
            return res.status(404).json({ message: 'Car not found' });
        }
        if (car.clientId.toString() !== authUserId.toString()) {
            return res.status(403).json({ message: 'Unauthorized to update this car' });
        }

        const { make, model, type, licensePlate, color, parkingSlot, removePhoto } = req.body;
        const updates = {};
        if (make !== undefined) updates.make = String(make).trim();
        if (model !== undefined) updates.model = String(model).trim();
        if (licensePlate !== undefined) updates.licensePlate = String(licensePlate).trim();
        if (color !== undefined) updates.color = String(color).trim();
        if (parkingSlot !== undefined) updates.parkingSlot = String(parkingSlot).trim();

        if (type !== undefined) {
            const normalizedType = normalizeCarType(type);
            if (normalizedType !== car.type) {
                const subscription = await findActiveSubscriptionForCar(authUserId, car._id);
                const subscriptionStatus = subscription?.status || 'inactive';
                if (['active', 'on_hold'].includes(subscriptionStatus)) {
                    return res.status(409).json({ message: 'Car type cannot be changed while a subscription is active or on hold.' });
                }
                updates.type = normalizedType;
            }
        }

        let previousPhoto = null;
        if (req.file) {
            previousPhoto = car.photo;
            updates.photo = resolveCarPhotoValue(req.file);
        } else if (removePhoto === 'true') {
            previousPhoto = car.photo;
            updates.photo = undefined;
        }

        Object.assign(car, updates);
        await car.save();

        if (previousPhoto && previousPhoto !== car.photo) {
            await removeCarPhotoFile(previousPhoto);
        }

        const carObject = car.toObject();
        res.json({ message: 'Car updated successfully', car: { ...carObject, photoUrl: buildCarPhotoUrl(req, car.photo) } });
    } catch (error) {
        console.error('Update car error:', error);
        if (error?.name === 'ValidationError' || error?.name === 'CastError') {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: error.message });
    }
});

// GET /subscribed-cars - list cars with active/on_hold subscriptions
router.get('/subscribed-cars', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ message: 'User ID required' });

        const cars = await Car.find({ clientId: userId }).sort({ createdAt: -1 }).lean();
        if (!cars.length) return res.json([]);

        const carIds = cars.map((car) => car._id);
        const subscriptions = await Subscription.find({
            userId,
            carId: { $in: carIds },
            status: { $in: ['active', 'on_hold'] }
        }).sort({ createdAt: -1 }).lean();

        const subscriptionByCar = new Map();
        for (const sub of subscriptions) {
            const key = sub.carId?.toString();
            if (key && !subscriptionByCar.has(key)) {
                subscriptionByCar.set(key, sub);
            }
        }

        let response = cars
            .map((car) => {
                const sub = subscriptionByCar.get(car._id.toString()) || null;
                if (!sub) return null;
                return {
                    car: { ...car, photoUrl: buildCarPhotoUrl(req, car.photo) },
                    subscription: sub
                };
            })
            .filter(Boolean);

        res.json(response);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /feedback
router.post('/feedback', async (req, res) => {
    try {
        const { userId, scheduleId, rating, comment } = req.body;

        const newReview = new Review({
            clientId: userId,
            scheduleId,
            rating,
            comment
        });

        await newReview.save();
        res.status(201).json({ message: 'Review submitted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /save-push-token
router.post('/save-push-token', verifyToken, async (req, res) => {
    try {
        const { userId, token } = req.body;
        const resolvedUserId = userId || req.user?.userId;
        if (!resolvedUserId || !token) {
            return res.status(400).json({ message: 'userId and token are required' });
        }
        if (req.user?.userId && String(req.user.userId) !== String(resolvedUserId)) {
            return res.status(403).json({ message: 'Unauthorized push token update' });
        }
        if (!Expo.isExpoPushToken(token)) {
            return res.status(400).json({ message: 'Invalid Expo push token' });
        }
        await User.updateMany(
            { _id: { $ne: resolvedUserId }, pushToken: token },
            { $unset: { pushToken: 1 } }
        );
        await User.findByIdAndUpdate(resolvedUserId, { pushToken: token });
        res.json({ message: 'Push token saved' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

router.delete('/push-token', verifyToken, async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(400).json({ message: 'User ID required' });
        }
        await User.findByIdAndUpdate(userId, { $unset: { pushToken: 1 } });
        res.json({ message: 'Push token cleared' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /test-push - send a test notification to the logged-in client
router.post('/test-push', verifyToken, async (req, res) => {
    try {
        const { title, body } = req.body;
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(400).json({ message: 'User ID required' });
        }
        const user = await User.findById(userId);
        if (!user || !user.pushToken) {
            return res.status(404).json({ message: 'Push token not found for this user' });
        }

        const payload = [{
            to: user.pushToken,
            sound: 'default',
            title: title || 'CleanRide Test Notification',
            body: body || 'This is a test push notification from CleanRide.',
            data: { type: 'test' }
        }];

        const result = await sendExpoPushNotifications(payload, { action: 'client-test-push', userId: String(userId) });
        res.json({ message: 'Test push sent', result });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizePhone = (value) => String(value || '').replace(/\D/g, '');

const buildDeletionRequestMessage = ({
    username,
    email,
    phone,
    secretQuestionProvided,
    verificationStatus,
    note,
    source,
    activeSubscriptions,
}) => {
    return [
        'ACCOUNT DELETION REQUEST',
        `Submitted at: ${new Date().toISOString()}`,
        `Source: ${source || 'unknown'}`,
        `Username: ${username || 'N/A'}`,
        `Email: ${email || 'N/A'}`,
        `Phone: ${phone || 'N/A'}`,
        `Secret question provided: ${secretQuestionProvided ? 'Yes' : 'No'}`,
        `Verification status: ${verificationStatus || 'unverified'}`,
        `Active subscriptions: ${typeof activeSubscriptions === 'number' ? activeSubscriptions : 'unknown'}`,
        `Notes: ${note || 'N/A'}`,
    ].join('\n');
};

// POST /account-deletion-request
router.post('/account-deletion-request', async (req, res) => {
    try {
        const { username, email, phone, secretQuestion, secretAnswer, note, source } = req.body;

        const normalizedUsername = (username || '').trim();
        const normalizedEmail = (email || '').trim().toLowerCase();
        const normalizedPhone = normalizePhone(phone);
        const normalizedQuestion = (secretQuestion || '').trim();
        const normalizedAnswer = (secretAnswer || '').trim().toLowerCase();

        if (!normalizedUsername && !normalizedEmail && !normalizedPhone) {
            return res.status(400).json({ message: 'Username, email, or phone is required.' });
        }
        if (!normalizedQuestion || !normalizedAnswer) {
            return res.status(400).json({ message: 'Secret question and answer are required.' });
        }

        let user = null;
        if (normalizedEmail) {
            user = await User.findOne({ email: new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i') });
        }
        if (!user && normalizedUsername) {
            user = await User.findOne({ username: new RegExp(`^${escapeRegex(normalizedUsername)}$`, 'i') });
        }
        if (!user && normalizedPhone) {
            user = await User.findOne({ phone: normalizedPhone });
        }

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        if (user.role !== 'client') {
            return res.status(403).json({ message: 'Only client accounts can request deletion.' });
        }

        const questionMatches = user.secretQuestion
            ? String(user.secretQuestion).trim() === normalizedQuestion
            : false;
        const answerMatches = questionMatches && user.secretAnswer
            ? await bcrypt.compare(normalizedAnswer, user.secretAnswer)
            : false;
        const verificationStatus = questionMatches && answerMatches ? 'verified' : 'unverified';

        const activeSubscriptions = await Subscription.countDocuments({
            userId: user._id,
            status: { $in: ['active', 'on_hold'] }
        });

        const contact = new Contact({
            userId: user._id,
            subject: 'ACCOUNT DELETION REQUEST',
            message: buildDeletionRequestMessage({
                username: normalizedUsername || user.username,
                email: normalizedEmail || user.email,
                phone: normalizedPhone || user.phone,
                secretQuestionProvided: Boolean(normalizedQuestion),
                verificationStatus,
                note: (note || '').trim(),
                source: source || 'app',
                activeSubscriptions,
            }),
        });

        await contact.save();

        res.status(201).json({ message: 'Deletion request submitted.' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /subscribe
router.post('/subscribe', async (req, res) => {
    try {
        const { userId, planId, carId } = req.body;

        if (!stripe) {
            return res.status(500).json({ message: 'Stripe is not configured on the server.' });
        }

        // Get the subscription plan details
        let plan = await SubscriptionPlan.findById(planId);
        if (!plan) {
            return res.status(404).json({ message: 'Subscription plan not found' });
        }
        if (!plan.price || plan.price <= 0) {
            return res.status(400).json({ message: 'Subscription plan has an invalid price' });
        }

        // Get car details
        const car = await Car.findById(carId);
        if (!car) {
            return res.status(404).json({ message: 'Car details not found' });
        }
        if (car.clientId.toString() !== userId.toString()) {
            return res.status(403).json({ message: 'Unauthorized car selection' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const existingSub = await Subscription.findOne({
            userId,
            carId,
            status: { $in: ['active', 'on_hold'] }
        }).sort({ createdAt: -1 });
        if (existingSub) {
            return res.status(409).json({ message: 'This car already has an active subscription. Please cancel it before subscribing again.' });
        }

        // 1) Get or Create Stripe Customer
        let stripeCustomerId = user.stripeCustomerId;
        if (!stripeCustomerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.name,
                phone: user.phone,
                metadata: { userId: String(userId) }
            });
            stripeCustomerId = customer.id;
            user.stripeCustomerId = stripeCustomerId;
            await user.save();
        }

        // 2) Ensure the plan has a Stripe Price in AED/month
        plan = await ensurePlanStripePricing(plan);
        if (!plan?.stripePriceId) {
            return res.status(500).json({ message: 'Subscription plan is not configured for Stripe billing.' });
        }

        // 3) Create Stripe Ephemeral Key (required for PaymentSheet Customer integration)
        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: stripeCustomerId },
            { apiVersion: STRIPE_API_VERSION }
        );

        // 4) Create Stripe Subscription (incomplete until payment succeeds)
        const stripeSubscription = await stripe.subscriptions.create({
            customer: stripeCustomerId,
            items: [{ price: plan.stripePriceId }],
            collection_method: 'charge_automatically',
            payment_behavior: 'default_incomplete',
            payment_settings: {
                payment_method_types: ['card'],
                save_default_payment_method: 'on_subscription'
            },
            metadata: {
                userId: String(userId),
                carId: String(carId),
                planId: String(planId)
            },
            expand: ['latest_invoice.payment_intent'],
        });

        let invoice = null;
        let paymentIntent = stripeSubscription?.latest_invoice?.payment_intent || null;
        if (!paymentIntent && stripeSubscription?.latest_invoice) {
            const invoiceId = typeof stripeSubscription.latest_invoice === 'string'
                ? stripeSubscription.latest_invoice
                : stripeSubscription.latest_invoice?.id;
            if (invoiceId) {
                invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payment_intent'] });
                if (invoice?.status === 'draft') {
                    invoice = await stripe.invoices.finalizeInvoice(invoiceId, { expand: ['payment_intent'] });
                }
                paymentIntent = invoice?.payment_intent || null;
            }
        }

        if (paymentIntent && typeof paymentIntent === 'string') {
            paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent);
        }

        const paymentIntentClientSecret = paymentIntent?.client_secret || null;
        let setupIntentClientSecret = null;

        if (!paymentIntentClientSecret) {
            const stripeStatus = String(stripeSubscription?.status || '').toLowerCase();
            const amountDue = typeof invoice?.amount_due === 'number' ? invoice.amount_due : null;
            const canSetupOnly = stripeStatus === 'trialing' || stripeStatus === 'active' || amountDue === 0;

            if (canSetupOnly) {
                let setupIntent = stripeSubscription?.pending_setup_intent || null;
                if (setupIntent && typeof setupIntent === 'string') {
                    setupIntent = await stripe.setupIntents.retrieve(setupIntent);
                }

                if (!setupIntent) {
                    setupIntent = await stripe.setupIntents.create({
                        customer: stripeCustomerId,
                        payment_method_types: ['card'],
                        usage: 'off_session'
                    });
                }

                setupIntentClientSecret = setupIntent?.client_secret || null;
            }
        }

        if (!paymentIntentClientSecret && !setupIntentClientSecret) {
            return res.status(502).json({
                message: 'Stripe did not return a payment intent for the subscription.',
                status: stripeSubscription?.status,
                amountDue: invoice?.amount_due ?? null
            });
        }

        res.status(200).json({
            stripeSubscriptionId: stripeSubscription.id,
            customerId: stripeCustomerId,
            customerEphemeralKeySecret: ephemeralKey.secret,
            paymentIntentClientSecret,
            setupIntentClientSecret
        });
    } catch (error) {
        console.error('Error creating subscription:', error);
        res.status(500).json({ message: error.message });
    }
});

// POST /subscribe/confirm
router.post('/subscribe/confirm', async (req, res) => {
    try {
        const { userId, planId, carId, stripeSubscriptionId } = req.body;

        if (!stripe) {
            return res.status(500).json({ message: 'Stripe is not configured on the server.' });
        }

        if (!userId || !planId || !carId || !stripeSubscriptionId) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const existing = await Subscription.findOne({ stripeSubscriptionId });
        if (existing) {
            return res.status(200).json({ subscription: existing });
        }

        const plan = await SubscriptionPlan.findById(planId);
        if (!plan) {
            return res.status(404).json({ message: 'Subscription plan not found' });
        }

        const car = await Car.findById(carId);
        if (!car) {
            return res.status(404).json({ message: 'Car details not found' });
        }
        if (car.clientId.toString() !== userId.toString()) {
            return res.status(403).json({ message: 'Unauthorized car selection' });
        }

        const user = await User.findById(userId);
        if (!user?.stripeCustomerId) {
            return res.status(404).json({ message: 'Stripe customer not found for this user' });
        }

        const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        const stripeCustomerId = typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer?.id;
        if (stripeCustomerId !== user.stripeCustomerId) {
            return res.status(403).json({ message: 'Stripe subscription does not belong to this customer' });
        }

        const metadata = stripeSub?.metadata || {};
        if (metadata.userId && String(metadata.userId) !== String(userId)) {
            return res.status(403).json({ message: 'Stripe subscription metadata mismatch (userId)' });
        }
        if (metadata.carId && String(metadata.carId) !== String(carId)) {
            return res.status(403).json({ message: 'Stripe subscription metadata mismatch (carId)' });
        }
        if (metadata.planId && String(metadata.planId) !== String(planId)) {
            return res.status(403).json({ message: 'Stripe subscription metadata mismatch (planId)' });
        }

        const stripeStatus = String(stripeSub.status || '').toLowerCase();
        if (stripeStatus !== 'active' && stripeStatus !== 'trialing') {
            return res.status(409).json({ message: `Subscription is not active yet (Stripe status: ${stripeSub.status}).` });
        }

        // Cancel any local active/on_hold subscription for this car (DB mirror)
        await Subscription.updateMany(
            { userId, carId, status: { $in: ['active', 'on_hold'] } },
            {
                status: 'cancelled',
                endDate: new Date(),
                $push: { statusHistory: { status: 'cancelled', action: 'system_cancel_new_sub', timestamp: new Date() } }
            }
        );

        const startDate = stripeSub.current_period_start
            ? new Date(stripeSub.current_period_start * 1000)
            : new Date();
        const endDate = stripeSub.current_period_end
            ? new Date(stripeSub.current_period_end * 1000)
            : undefined;

        const onHold = Boolean(stripeSub.pause_collection);
        const localStatus = onHold ? 'on_hold' : 'active';

        const newSubscription = new Subscription({
            userId,
            carId,
            planId: String(planId),
            status: localStatus,
            startDate,
            endDate,
            stripeSubscriptionId: stripeSub.id,
            planDetails: {
                type: plan.planType,
                carType: plan.carType,
                price: plan.price,
                features: plan.features,
                washFrequency: plan.washFrequency
            },
            statusHistory: [{ status: localStatus, action: 'stripe_confirm', timestamp: new Date() }]
        });

        await newSubscription.save();
        res.status(201).json({ subscription: newSubscription });
    } catch (error) {
        console.error('Error confirming subscription:', error);
        const stripeMessage = error?.raw?.message || error?.message || 'Subscription confirmation failed';
        res.status(500).json({ message: stripeMessage });
    }
});

// PUT /subscription/:id
router.put('/subscription/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { action } = req.body;

        const subscription = await Subscription.findById(id);
        if (!subscription) return res.status(404).json({ message: 'Subscription not found' });

        if (!stripe || !subscription.stripeSubscriptionId) {
            return res.status(500).json({ message: 'Stripe subscription not configured.' });
        }

        const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
        const stripeStatus = String(stripeSub?.status || '').toLowerCase();
        if (stripeStatus === 'canceled' || stripeStatus === 'cancelled') {
            if (subscription.status !== 'cancelled') {
                subscription.status = 'cancelled';
                subscription.endDate = new Date();
                subscription.statusHistory.push({ status: 'cancelled', action: 'stripe_cancelled_sync' });
                await subscription.save();
            }
            return res.status(400).json({ message: 'Subscription is already cancelled on Stripe.' });
        }

        const stripePaused = Boolean(stripeSub?.pause_collection);
        let updatedStripeSub = stripeSub;

        try {
            if (action === 'cancel') {
                updatedStripeSub = await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
            } else if (action === 'hold') {
                if (!stripePaused) {
                    updatedStripeSub = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
                        pause_collection: { behavior: 'void' }
                    });
                }
            } else if (action === 'unhold') {
                if (stripePaused) {
                    updatedStripeSub = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
                        pause_collection: null
                    });
                }
            } else {
                return res.status(400).json({ message: 'Invalid action' });
            }
        } catch (e) {
            console.error('Stripe subscription update failed:', e.message);
            const stripeMessage = e?.raw?.message || e?.message || 'Stripe update failed.';
            return res.status(502).json({ message: stripeMessage });
        }

        const updatedStatus = String(updatedStripeSub?.status || '').toLowerCase();
        const updatedPaused = Boolean(updatedStripeSub?.pause_collection);

        let nextLocalStatus = 'inactive';
        if (updatedStatus === 'canceled' || updatedStatus === 'cancelled') {
            nextLocalStatus = 'cancelled';
        } else if (updatedStatus === 'active' || updatedStatus === 'trialing') {
            nextLocalStatus = updatedPaused ? 'on_hold' : 'active';
        }

        subscription.status = nextLocalStatus;
        if (updatedStripeSub?.current_period_start) {
            subscription.startDate = new Date(updatedStripeSub.current_period_start * 1000);
        }
        if (updatedStripeSub?.current_period_end) {
            subscription.endDate = new Date(updatedStripeSub.current_period_end * 1000);
        }
        if (nextLocalStatus === 'cancelled') {
            subscription.endDate = new Date();
        }

        const actionByStatus = {
            active: 'unhold',
            on_hold: 'hold',
            cancelled: 'cancel',
            inactive: 'stripe_sync'
        };
        subscription.statusHistory.push({ status: nextLocalStatus, action: actionByStatus[nextLocalStatus] || action });

        await subscription.save();
        res.json({ message: 'Subscription updated', subscription });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /payment-method - get the client's saved card (for display), lazily backfilling from Stripe
router.get('/payment-method', verifyToken, async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(400).json({ message: 'User ID required' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (!user.stripeCustomerId) {
            return res.json({ card: null, hasStripeCustomer: false });
        }

        if (user.cardBrand && user.cardLast4) {
            return res.json({
                card: {
                    brand: user.cardBrand,
                    last4: user.cardLast4,
                    expMonth: user.cardExpMonth,
                    expYear: user.cardExpYear
                },
                hasStripeCustomer: true
            });
        }

        if (!stripe) {
            return res.json({ card: null, hasStripeCustomer: true });
        }

        // Lazy backfill for users who already had a card on file before this
        // endpoint existed: check the customer's default payment method first...
        let paymentMethod = null;
        try {
            const customer = await stripe.customers.retrieve(user.stripeCustomerId, {
                expand: ['invoice_settings.default_payment_method']
            });
            const pm = customer?.invoice_settings?.default_payment_method;
            if (pm && typeof pm === 'object') {
                paymentMethod = pm;
            }
        } catch (error) {
            console.warn('Failed to retrieve Stripe customer for payment method backfill:', error.message);
        }

        // ...and if that's empty, fall back to the most recent active subscription's
        // default payment method (subscriptions created before this feature only ever
        // got a per-subscription default, never a customer-level one).
        if (!paymentMethod) {
            const recentSub = await Subscription.findOne({
                userId,
                status: { $in: ['active', 'on_hold'] },
                stripeSubscriptionId: { $exists: true, $ne: null }
            }).sort({ createdAt: -1 });

            if (recentSub?.stripeSubscriptionId) {
                try {
                    const stripeSub = await stripe.subscriptions.retrieve(recentSub.stripeSubscriptionId, {
                        expand: ['default_payment_method']
                    });
                    const pm = stripeSub?.default_payment_method;
                    if (pm && typeof pm === 'object') {
                        paymentMethod = pm;
                    }
                } catch (error) {
                    console.warn('Failed to retrieve Stripe subscription for payment method backfill:', error.message);
                }
            }
        }

        if (!paymentMethod?.card) {
            return res.json({ card: null, hasStripeCustomer: true });
        }

        user.stripeDefaultPaymentMethodId = paymentMethod.id;
        user.cardBrand = paymentMethod.card.brand;
        user.cardLast4 = paymentMethod.card.last4;
        user.cardExpMonth = paymentMethod.card.exp_month;
        user.cardExpYear = paymentMethod.card.exp_year;
        user.cardUpdatedAt = new Date();
        await user.save();

        res.json({
            card: {
                brand: user.cardBrand,
                last4: user.cardLast4,
                expMonth: user.cardExpMonth,
                expYear: user.cardExpYear
            },
            hasStripeCustomer: true
        });
    } catch (error) {
        console.error('Error fetching payment method:', error);
        res.status(500).json({ message: error.message });
    }
});

// POST /payment-method/setup - start a card update: create a SetupIntent + ephemeral key
router.post('/payment-method/setup', verifyToken, async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(400).json({ message: 'User ID required' });
        }

        if (!stripe) {
            return res.status(500).json({ message: 'Stripe is not configured on the server.' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Reuses the same lazy-create pattern as POST /subscribe so this never
        // dead-ends for a user who hasn't subscribed to anything yet.
        let stripeCustomerId = user.stripeCustomerId;
        if (!stripeCustomerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.name,
                phone: user.phone,
                metadata: { userId: String(userId) }
            });
            stripeCustomerId = customer.id;
            user.stripeCustomerId = stripeCustomerId;
            await user.save();
        }

        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: stripeCustomerId },
            { apiVersion: STRIPE_API_VERSION }
        );

        const setupIntent = await stripe.setupIntents.create({
            customer: stripeCustomerId,
            payment_method_types: ['card'],
            usage: 'off_session'
        });

        res.status(200).json({
            customerId: stripeCustomerId,
            customerEphemeralKeySecret: ephemeralKey.secret,
            setupIntentClientSecret: setupIntent.client_secret,
            setupIntentId: setupIntent.id
        });
    } catch (error) {
        console.error('Error starting payment method update:', error);
        res.status(500).json({ message: error.message });
    }
});

// POST /payment-method/confirm - finalize a card update after the PaymentSheet succeeds:
// makes the new card the customer's default, then switches every currently active/on_hold
// subscription over to it (a user can have several subscriptions, one per car).
router.post('/payment-method/confirm', verifyToken, async (req, res) => {
    try {
        const userId = req.user?.userId;
        const { setupIntentId } = req.body;

        if (!userId) {
            return res.status(400).json({ message: 'User ID required' });
        }
        if (!setupIntentId) {
            return res.status(400).json({ message: 'Missing setupIntentId' });
        }
        if (!stripe) {
            return res.status(500).json({ message: 'Stripe is not configured on the server.' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        if (!user.stripeCustomerId) {
            return res.status(404).json({ message: 'No Stripe customer found for this user.' });
        }

        const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
            expand: ['payment_method']
        });

        const setupIntentCustomerId = typeof setupIntent.customer === 'string'
            ? setupIntent.customer
            : setupIntent.customer?.id;
        if (setupIntentCustomerId !== user.stripeCustomerId) {
            return res.status(403).json({ message: 'Setup intent does not belong to this customer.' });
        }

        // Authoritative check - never trust the client's claim that the sheet succeeded.
        if (setupIntent.status !== 'succeeded') {
            return res.status(409).json({
                message: setupIntent.last_setup_error?.message || 'Card setup was not completed successfully.',
                status: setupIntent.status
            });
        }

        const paymentMethod = setupIntent.payment_method;
        const paymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod?.id;
        if (!paymentMethodId) {
            return res.status(502).json({ message: 'Stripe did not return a payment method for this setup intent.' });
        }

        if (user.stripeDefaultPaymentMethodId === paymentMethodId) {
            return res.json({
                message: 'This is already your default payment method.',
                card: {
                    brand: user.cardBrand,
                    last4: user.cardLast4,
                    expMonth: user.cardExpMonth,
                    expYear: user.cardExpYear
                },
                updatedSubscriptionCount: 0,
                failedSubscriptions: []
            });
        }

        // Anchor step: this must succeed before touching any subscription. The old card
        // is left attached to the customer (not detached) so it isn't lost if needed again.
        try {
            await stripe.customers.update(user.stripeCustomerId, {
                invoice_settings: { default_payment_method: paymentMethodId }
            });
        } catch (error) {
            console.error('Failed to set customer default payment method:', error.message);
            const stripeMessage = error?.raw?.message || error?.message || 'Failed to update default payment method.';
            return res.status(502).json({ message: stripeMessage });
        }

        const cardDetails = typeof paymentMethod === 'object' ? paymentMethod.card : null;
        user.stripeDefaultPaymentMethodId = paymentMethodId;
        if (cardDetails) {
            user.cardBrand = cardDetails.brand;
            user.cardLast4 = cardDetails.last4;
            user.cardExpMonth = cardDetails.exp_month;
            user.cardExpYear = cardDetails.exp_year;
        }
        user.cardUpdatedAt = new Date();
        await user.save();

        const activeSubs = await Subscription.find({
            userId,
            status: { $in: ['active', 'on_hold'] },
            stripeSubscriptionId: { $exists: true, $ne: null }
        });

        const results = await Promise.allSettled(
            activeSubs.map((sub) =>
                stripe.subscriptions.update(sub.stripeSubscriptionId, { default_payment_method: paymentMethodId })
            )
        );

        const failedSubscriptions = [];
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                failedSubscriptions.push({
                    subscriptionId: String(activeSubs[index]._id),
                    stripeSubscriptionId: activeSubs[index].stripeSubscriptionId,
                    error: result.reason?.raw?.message || result.reason?.message || 'Update failed'
                });
            }
        });

        res.json({
            message: failedSubscriptions.length
                ? `Card saved, but ${failedSubscriptions.length} subscription(s) could not be switched automatically.`
                : 'Payment method updated.',
            card: {
                brand: user.cardBrand,
                last4: user.cardLast4,
                expMonth: user.cardExpMonth,
                expYear: user.cardExpYear
            },
            updatedSubscriptionCount: activeSubs.length - failedSubscriptions.length,
            failedSubscriptions
        });
    } catch (error) {
        console.error('Error confirming payment method update:', error);
        const stripeMessage = error?.raw?.message || error?.message || 'Payment method update failed';
        res.status(500).json({ message: stripeMessage });
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

// PUT /car/:id
router.put('/car/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        if (updates.type) {
            const normalized = String(updates.type).toLowerCase().replace(/_/g, '-');
            if (normalized.includes('hatch')) updates.type = 'hatchback';
            else if (normalized.includes('suv-large') || normalized.includes('suvlarge')) updates.type = 'large-suv';
            else if (normalized.includes('large') && normalized.includes('suv')) updates.type = 'large-suv';
            else if (normalized.includes('mid') && normalized.includes('suv')) updates.type = 'mid-suv';
            else if (normalized.includes('sedan/mid-suv')) updates.type = 'mid-suv';
            else if (normalized.includes('sedan')) updates.type = 'sedan';
            else if (normalized.includes('suv')) updates.type = 'mid-suv';
            else updates.type = 'sedan';
        }
        const updatedCar = await Car.findByIdAndUpdate(id, updates, { new: true });
        res.json(updatedCar);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});



// POST /contact
router.post('/contact', async (req, res) => {
    try {
        const { userId, message, subject } = req.body;

        const newContact = new Contact({
            userId,
            subject,
            message
        });

        await newContact.save();
        
        // Create notification for admin
        const Notification = require('../models/Notification');
        const user = await User.findById(userId);
        
        const newNotification = new Notification({
            recipientRole: 'admin',
            title: 'New Contact Message',
            message: `New contact message from ${user?.name || 'a client'}: ${subject}`
        });
        await newNotification.save();
        
        res.json({ message: 'Message received. We will contact you shortly.' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
