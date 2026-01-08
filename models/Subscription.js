const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    carId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Car'
    },
    planId: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'on_hold', 'cancelled'],
        default: 'active'
    },
    startDate: {
        type: Date,
        default: Date.now
    },
    endDate: {
        type: Date
    },
    stripeSubscriptionId: {
        type: String
    },
    planDetails: {
        type: { type: String },
        carType: { type: String },
        price: { type: Number },
        features: [{ type: String }],
        washFrequency: { type: String }
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    statusHistory: [{
        status: { type: String },
        action: { type: String }, // 'create', 'hold', 'unhold', 'cancel'
        timestamp: { type: Date, default: Date.now }
    }]
});

module.exports = mongoose.model('Subscription', subscriptionSchema, 'subscriptions');
