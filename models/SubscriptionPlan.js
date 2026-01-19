const mongoose = require('mongoose');

const subscriptionPlanSchema = new mongoose.Schema({
    carType: {
        type: String,
        enum: ['hatchback', 'sedan', 'mid-suv', 'large-suv'],
        required: true
    },
    planType: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true
    },
    features: [{
        type: String
    }],
    washFrequency: {
        type: String,
        default: '3 times per week'
    },
    stripeProductId: {
        type: String
    },
    stripePriceId: {
        type: String
    },
    stripeCurrency: {
        type: String,
        default: 'aed'
    },
    stripeUnitAmount: {
        type: Number
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

subscriptionPlanSchema.pre('save', function () {
    if (this.planType) {
        this.planType = this.planType.toLowerCase();
    }
    if (this.stripeCurrency) {
        this.stripeCurrency = this.stripeCurrency.toLowerCase();
    }
    this.updatedAt = Date.now();
});

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema, 'subscriptionPlans');
