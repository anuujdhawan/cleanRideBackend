const express = require('express');
const router = express.Router();
const Schedule = require('../models/Schedule');
const Car = require('../models/Car');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const WashRecord = require('../models/WashRecord');
const { logActivity } = require('../utils/activityLogger');
const { resolveCarPhotoUrl } = require('../utils/carPhotoUrl');
const { sendExpoPushNotifications } = require('../utils/expoPush');

const pushDebugEnabled = process.env.ENABLE_PUSH_DEBUG === 'true';
const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || process.env.APP_TIME_ZONE || 'Asia/Dubai';
const DEFAULT_WASH_DAY_PATTERN = 'Mon,Wed,Fri';
const WASH_DAY_PATTERNS = {
    'Mon,Wed,Fri': [1, 3, 5],
    'Tue,Thu,Sat': [2, 4, 6]
};
const DAY_NAME_ALIASES = {
    Sun: 0,
    Sunday: 0,
    Mon: 1,
    Monday: 1,
    Tue: 2,
    Tuesday: 2,
    Wed: 3,
    Wednesday: 3,
    Thu: 4,
    Thursday: 4,
    Fri: 5,
    Friday: 5,
    Sat: 6,
    Saturday: 6
};
const INDEX_TO_DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COMPACT_WASH_DAY_ALIASES = {
    mwf: 'Mon,Wed,Fri',
    tts: 'Tue,Thu,Sat'
};

const getDateKeyParts = (value) => {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: BUSINESS_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const parts = formatter.formatToParts(new Date(value));
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (!year || !month || !day) {
        return null;
    }
    return { year, month, day };
};

const toLocalDateKey = (value) => {
    const parts = getDateKeyParts(value);
    if (!parts) return null;
    const { year, month, day } = parts;
    return `${year}-${month}-${day}`;
};

const toUtcDateMarker = (year, monthIndex, day) => new Date(Date.UTC(year, monthIndex, day, 12, 0, 0, 0));

const markerToDateKey = (value) => {
    const date = new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const parseLocalDateKey = (value) => {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const day = Number(match[3]);
    const parsed = toUtcDateMarker(year, monthIndex, day);
    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== monthIndex ||
        parsed.getUTCDate() !== day
    ) {
        return null;
    }
    return parsed;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getFallbackWashDayPattern = (clientIndex) => {
    const cycleIndex = clientIndex % 120;
    return cycleIndex < 50 ? 'Mon,Wed,Fri' : 'Tue,Thu,Sat';
};

const normalizeWashDayPattern = (value, fallbackPattern = DEFAULT_WASH_DAY_PATTERN) => {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (WASH_DAY_PATTERNS[raw]) return raw;

    const compactAlias = COMPACT_WASH_DAY_ALIASES[raw.toLowerCase()];
    if (compactAlias) return compactAlias;

    const resolvedDays = raw
        .split(',')
        .map((part) => {
            const trimmed = part.trim();
            const aliasKey = Object.keys(DAY_NAME_ALIASES).find(
                (dayName) => dayName.toLowerCase() === trimmed.toLowerCase()
            );
            return aliasKey ? DAY_NAME_ALIASES[aliasKey] : undefined;
        })
        .filter((dayIndex) => typeof dayIndex === 'number');

    if (resolvedDays.length) {
        const uniqueDays = [...new Set(resolvedDays)].sort((a, b) => a - b);
        const normalized = uniqueDays.map((dayIndex) => INDEX_TO_DAY_NAME[dayIndex]).join(',');
        if (WASH_DAY_PATTERNS[normalized]) {
            return normalized;
        }
    }

    return WASH_DAY_PATTERNS[fallbackPattern] ? fallbackPattern : DEFAULT_WASH_DAY_PATTERN;
};

const getScheduleDays = (pattern) => WASH_DAY_PATTERNS[pattern] || WASH_DAY_PATTERNS[DEFAULT_WASH_DAY_PATTERN];

// GET /building-clients
router.get('/building-clients', async (req, res) => {
    try {
        const { buildingName } = req.query;
        const todayOnly = String(req.query.todayOnly ?? 'true').toLowerCase() !== 'false';
        if (!buildingName) {
            return res.status(400).json({ message: 'Building name is required' });
        }

        const now = new Date();
        const todayDateKey = toLocalDateKey(now);
        const todayMarker = parseLocalDateKey(todayDateKey);

        const isScheduledDay = (date, scheduledDays) => scheduledDays.includes(date.getUTCDay());

        const buildingNameMatcher = new RegExp(`^\\s*${escapeRegex(String(buildingName).trim())}\\s*$`, 'i');
        const allClients = await User.find({ role: 'client', buildingName: buildingNameMatcher })
            .sort({ createdAt: 1, _id: 1 });
        const clientIds = allClients.map((client) => client._id);
        const cars = await Car.find({ clientId: { $in: clientIds } }).sort({ createdAt: -1 }).lean();
        const carById = new Map();
        const carsByClient = new Map();
        cars.forEach((car) => {
            carById.set(car._id.toString(), car);
            const key = car.clientId.toString();
            const list = carsByClient.get(key) || [];
            list.push(car);
            carsByClient.set(key, list);
        });

        const subscriptions = await Subscription.find({
            userId: { $in: clientIds },
            status: 'active'
        }).sort({ createdAt: -1 }).lean();
        const subscriptionsByClient = new Map();
        subscriptions.forEach((sub) => {
            const userKey = sub.userId?.toString?.() || String(sub.userId);
            const list = subscriptionsByClient.get(userKey) || [];
            list.push(sub);
            subscriptionsByClient.set(userKey, list);
        });
        const result = [];

        for (let clientIndex = 0; clientIndex < allClients.length; clientIndex += 1) {
            const client = allClients[clientIndex];
            const clientCars = carsByClient.get(client._id.toString()) || [];
            const clientSubscriptions = subscriptionsByClient.get(client._id.toString()) || [];
            if (!clientSubscriptions.length) continue;

            const washDayPattern = normalizeWashDayPattern(
                client.washDays,
                getFallbackWashDayPattern(clientIndex)
            );
            const scheduledDays = getScheduleDays(washDayPattern);
            const assignedCarIds = new Set();
            const unresolvedSubscriptions = [];
            const scheduleRows = [];

            for (const subscription of clientSubscriptions) {
                const subscriptionCarId = subscription.carId?.toString?.();
                const subscriptionCar = subscriptionCarId ? carById.get(subscriptionCarId) : null;
                const belongsToClient = subscriptionCar?.clientId?.toString?.() === client._id.toString();

                if (!subscriptionCar || !belongsToClient) {
                    unresolvedSubscriptions.push(subscription);
                    continue;
                }

                if (assignedCarIds.has(subscriptionCarId)) continue;
                assignedCarIds.add(subscriptionCarId);
                scheduleRows.push({ subscription, car: subscriptionCar });
            }

            const fallbackCars = clientCars.filter((car) => !assignedCarIds.has(car._id.toString()));
            for (const subscription of unresolvedSubscriptions) {
                const fallbackCar = fallbackCars.shift();
                if (!fallbackCar) continue;
                assignedCarIds.add(fallbackCar._id.toString());
                scheduleRows.push({ subscription, car: fallbackCar });
            }

            for (const { subscription, car } of scheduleRows) {
                const planName = subscription?.planDetails?.type || subscription?.planDetails?.planType || null;
                const carPhotoUrl = resolveCarPhotoUrl(req, car?.photo);
                const baseRow = {
                    ...client.toObject(),
                    planName,
                    carPhotoUrl,
                    washDays: washDayPattern,
                    subscriptionStatus: subscription.status,
                    carDetails: car ? {
                        _id: car._id,
                        make: car.make,
                        model: car.model,
                        color: car.color,
                        licensePlate: car.licensePlate,
                        parkingSlot: car.parkingSlot,
                        type: car.type
                    } : null
                };

                if (!todayOnly) {
                    result.push({
                        ...baseRow,
                        status: subscription.status
                    });
                    continue;
                }

                // Calculate status for todayOnly view
                let status = 'scheduled';
                let pendingForDate = null;

                try {
                    // Query wash records for THIS specific car only to prevent
                    // old records (without carId or from another car) from fulfilling
                    // scheduled days for the current car
                    const washRecords = await WashRecord.find({
                        clientId: client._id,
                        carId: car._id,
                        $or: [
                            { washDate: { $lte: now } },
                            { washForDate: { $ne: null, $lte: todayMarker } }
                        ]
                    }).lean();

                    const fulfilledDateKeys = new Set();
                    let washedToday = false;
                    for (const washRecord of washRecords) {
                        if (washRecord?.washDate) {
                            const washDateKey = toLocalDateKey(washRecord.washDate);
                            if (washDateKey === todayDateKey) {
                                washedToday = true;
                            }
                            const washDateMarker = parseLocalDateKey(washDateKey);
                            if (washDateMarker && isScheduledDay(washDateMarker, scheduledDays)) {
                                fulfilledDateKeys.add(washDateKey);
                            }
                        }
                        if (washRecord?.washForDate) {
                            fulfilledDateKeys.add(toLocalDateKey(washRecord.washForDate));
                        }
                    }

                    if (washedToday) {
                        status = 'washed';
                    } else {
                        // 1. Walk backwards from yesterday → first missed scheduled day → 'pending'
                        let foundPending = false;
                        const maxLookbackDays = 14;
                        for (let daysBack = 1; daysBack <= maxLookbackDays; daysBack++) {
                            const checkDate = new Date(todayMarker);
                            checkDate.setUTCDate(checkDate.getUTCDate() - daysBack);
                            const checkDay = checkDate.getUTCDay();
                            if (!scheduledDays.includes(checkDay)) continue;
                            const checkKey = markerToDateKey(checkDate);
                            if (!fulfilledDateKeys.has(checkKey)) {
                                status = 'pending';
                                pendingForDate = checkKey;
                                foundPending = true;
                                break;
                            }
                        }

                        // 2. No past missed washes → if today is a scheduled day → 'scheduled'
                        if (!foundPending) {
                            const todayDay = todayMarker?.getUTCDay?.();
                            if (todayDay !== undefined && scheduledDays.includes(todayDay)) {
                                status = 'scheduled';
                            } else {
                                status = 'scheduled';
                            }
                        }
                    }
                } catch (carError) {
                    console.error(`Error calculating status for car ${car?._id} (client ${client._id}):`, carError);
                    status = 'pending';
                    pendingForDate = todayDateKey;
                }

                result.push({
                    ...baseRow,
                    status,
                    pendingForDate
                });
            }
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /record-wash
router.post('/record-wash', async (req, res) => {
    try {
        const { clientId, cleanerId, carId, washForDate } = req.body;
        if (!clientId || !cleanerId) {
            return res.status(400).json({ message: 'Missing required fields' });
        }
        let resolvedWashForDate = null;
        if (washForDate !== undefined && washForDate !== null && String(washForDate).trim()) {
            resolvedWashForDate = parseLocalDateKey(String(washForDate));
            if (!resolvedWashForDate) {
                return res.status(400).json({ message: 'washForDate must be in YYYY-MM-DD format' });
            }
        }

        const now = new Date();
        const washDate = now;
        const washTime = now.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: BUSINESS_TIME_ZONE
        });

        const newWash = new WashRecord({
            clientId,
            cleanerId,
            carId,
            washDate,
            washForDate: resolvedWashForDate || undefined,
            washTime
        });
        await newWash.save();

        // Get client/car info for activity log and push notification
        const client = await User.findById(clientId);
        const car = carId ? await Car.findById(carId) : null;
        const licensePlate = car?.licensePlate || 'Unknown';

        // Log activity
        await logActivity('wash_status', `Wash Status Updated (${licensePlate})`, {
            userId: clientId,
            licensePlate,
            status: 'completed'
        });

        // Send Push Notification to Client
        if (client && client.pushToken) {
            await sendExpoPushNotifications([{
                to: client.pushToken,
                sound: 'default',
                title: 'Car Wash Completed',
                body: `Your car (${licensePlate}) has been washed!`,
                data: { washId: newWash._id },
            }], { action: 'record-wash', clientId: String(clientId), carId: carId ? String(carId) : null });
        }

        res.status(201).json(newWash);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// POST /test-push (debug)
router.post('/test-push', async (req, res) => {
    try {
        if (!pushDebugEnabled) {
            return res.status(404).json({ message: 'Not found' });
        }
        const { clientId, title, body } = req.body;
        if (!clientId) {
            return res.status(400).json({ message: 'clientId is required' });
        }
        const client = await User.findById(clientId);
        if (!client || !client.pushToken) {
            return res.status(404).json({ message: 'Client push token not found' });
        }

        const payload = [{
            to: client.pushToken,
            sound: 'default',
            title: title || 'CleanRide Test Notification',
            body: body || 'Test push sent from cleaner debug.',
            data: { type: 'cleaner-test' }
        }];

        const result = await sendExpoPushNotifications(payload, { action: 'cleaner-test-push', clientId: String(clientId) });
        res.json({ message: 'Test push sent', result });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /today-washes
router.get('/today-washes', async (req, res) => {
    try {
        const { cleanerId } = req.query;
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 999);

        const washes = await WashRecord.find({
            cleanerId,
            washDate: { $gte: start, $lte: end }
        });
        res.json(washes);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET /schedule
router.get('/schedule', async (req, res) => {
    try {
        const { cleanerId, date } = req.query;
        let query = {};
        if (cleanerId) query.cleanerId = cleanerId;

        if (date) {
            const start = new Date(date);
            start.setHours(0, 0, 0, 0);
            const end = new Date(date);
            end.setHours(23, 59, 59, 999);
            query.scheduledDate = { $gte: start, $lte: end };
        }

        const schedules = await Schedule.find(query)
            .populate('carId')
            .populate('clientId', 'name phone pushToken')
            .sort({ startTime: 1 });

        res.json(schedules);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PUT /status/:scheduleId
router.put('/status/:scheduleId', async (req, res) => {
    try {
        const { status } = req.body;
        const { scheduleId } = req.params;

        const updatedSchedule = await Schedule.findByIdAndUpdate(
            scheduleId,
            { status },
            { new: true }
        );

        if (!updatedSchedule) {
            return res.status(404).json({ message: 'Schedule not found' });
        }

        if (status === 'completed') {
            const schedule = await Schedule.findById(scheduleId).populate('clientId');
            if (schedule && schedule.clientId && schedule.clientId.pushToken) {
                await sendExpoPushNotifications([{
                    to: schedule.clientId.pushToken,
                    sound: 'default',
                    title: 'Car Wash Completed',
                    body: `Your car wash for ${schedule.scheduledDate.toDateString()} has been completed!`,
                    data: { scheduleId: schedule._id },
                }], { action: 'schedule-completed', scheduleId: String(scheduleId) });
            }
        }

        res.json(updatedSchedule);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
