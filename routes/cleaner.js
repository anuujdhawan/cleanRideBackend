const express = require('express');
const router = express.Router();
const Schedule = require('../models/Schedule');
const Car = require('../models/Car');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const WashRecord = require('../models/WashRecord');
const { logActivity } = require('../utils/activityLogger');

// GET /building-clients
router.get('/building-clients', async (req, res) => {
    try {
        const { buildingName } = req.query;
        if (!buildingName) {
            return res.status(400).json({ message: 'Building name is required' });
        }

        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const now = new Date();
        const today = days[now.getDay()];

        // Helper to get last scheduled day for a pattern
        const getLastScheduledDay = (pattern, date) => {
            const d = new Date(date);
            const mwf = [1, 3, 5]; // Mon, Wed, Fri
            const tts = [2, 4, 6]; // Tue, Thu, Sat
            const targetDays = pattern === 'Mon,Wed,Fri' ? mwf : tts;

            // Check today first
            if (targetDays.includes(d.getDay())) return new Date(d.setHours(0, 0, 0, 0));

            // Look back up to 6 days
            for (let i = 1; i <= 6; i++) {
                const prev = new Date(date);
                prev.setDate(prev.getDate() - i);
                if (targetDays.includes(prev.getDay())) return new Date(prev.setHours(0, 0, 0, 0));
            }
            return null;
        };

        const allClients = await User.find({ role: 'client', buildingName });
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
        const subscriptionByClient = new Map();
        subscriptions.forEach((sub) => {
            const key = sub.userId.toString();
            if (!subscriptionByClient.has(key)) {
                subscriptionByClient.set(key, sub);
            }
        });
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const result = [];

        for (const client of allClients) {
            const subscription = subscriptionByClient.get(client._id.toString());
            if (!subscription) continue;

            const clientCars = carsByClient.get(client._id.toString()) || [];
            let car = null;
            if (subscription.carId) {
                car = carById.get(subscription.carId.toString());
            }
            if (!car && clientCars.length === 1) {
                car = clientCars[0];
            }
            if (!car) continue;

            const hasSingleCar = clientCars.length === 1;
            const carQuery = hasSingleCar
                ? { $or: [{ carId: car._id }, { carId: { $exists: false } }, { carId: null }] }
                : { carId: car._id };

            // 1. Check if washed TODAY
            const todayStart = new Date(now);
            todayStart.setHours(0, 0, 0, 0);
            const todayEnd = new Date(now);
            todayEnd.setHours(23, 59, 59, 999);

            const washedToday = await WashRecord.findOne({
                clientId: client._id,
                ...carQuery,
                washDate: { $gte: todayStart, $lte: todayEnd }
            });

            if (washedToday) {
                const carPhotoUrl = car?.photo ? `${baseUrl}/public/car-photos/${car.photo}` : null;
                result.push({
                    ...client.toObject(),
                    status: 'washed',
                    carPhotoUrl,
                    carDetails: car ? {
                        _id: car._id,
                        make: car.make,
                        model: car.model,
                        color: car.color,
                        licensePlate: car.licensePlate,
                        type: car.type
                    } : null
                });
                continue;
            }

            // 2. If not washed today, determine if it's scheduled or pending
            const lastScheduled = getLastScheduledDay(client.washDays, now);
            if (!lastScheduled) continue;

            const isScheduledToday = lastScheduled.toDateString() === now.toDateString();

            if (isScheduledToday) {
                const carPhotoUrl = car?.photo ? `${baseUrl}/public/car-photos/${car.photo}` : null;
                result.push({
                    ...client.toObject(),
                    status: 'scheduled',
                    carPhotoUrl,
                    carDetails: car ? {
                        _id: car._id,
                        make: car.make,
                        model: car.model,
                        color: car.color,
                        licensePlate: car.licensePlate,
                        type: car.type
                    } : null
                });
            } else {
                // Check if it was washed on its last scheduled day
                const schedStart = new Date(lastScheduled);
                const schedEnd = new Date(lastScheduled);
                schedEnd.setHours(23, 59, 59, 999);

                const washedOnSchedDay = await WashRecord.findOne({
                    clientId: client._id,
                    ...carQuery,
                    washDate: { $gte: schedStart, $lte: schedEnd }
                });

                if (!washedOnSchedDay) {
                    // Missed the last scheduled day -> Pending
                    const carPhotoUrl = car?.photo ? `${baseUrl}/public/car-photos/${car.photo}` : null;
                    result.push({
                        ...client.toObject(),
                        status: 'pending',
                        carPhotoUrl,
                    carDetails: car ? {
                        _id: car._id,
                        make: car.make,
                        model: car.model,
                        color: car.color,
                        licensePlate: car.licensePlate,
                        type: car.type
                    } : null
                    });
                }
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
        const { clientId, cleanerId, carId } = req.body;
        if (!clientId || !cleanerId) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const now = new Date();
        const washDate = now;
        const washTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const newWash = new WashRecord({
            clientId,
            cleanerId,
            carId,
            washDate,
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
            const { Expo } = require('expo-server-sdk');
            const expo = new Expo();

            if (Expo.isExpoPushToken(client.pushToken)) {
                await expo.sendPushNotificationsAsync([{
                    to: client.pushToken,
                    sound: 'default',
                    title: 'Car Wash Completed',
                    body: `Your car (${licensePlate}) has been washed!`,
                    data: { washId: newWash._id },
                }]);
            }
        }

        res.status(201).json(newWash);
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
                const { Expo } = require('expo-server-sdk');
                const expo = new Expo();

                if (Expo.isExpoPushToken(schedule.clientId.pushToken)) {
                    await expo.sendPushNotificationsAsync([{
                        to: schedule.clientId.pushToken,
                        sound: 'default',
                        title: 'Car Wash Completed',
                        body: `Your car wash for ${schedule.scheduledDate.toDateString()} has been completed!`,
                        data: { scheduleId: schedule._id },
                    }]);
                }
            }
        }

        res.json(updatedSchedule);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
