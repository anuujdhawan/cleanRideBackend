const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['subscription', 'wash_status', 'cleaner_added', 'cleaner_updated', 'customer_added', 'developer_added', 'developer_updated', 'developer_deleted'],
        required: true
    },
    message: {
        type: String,
        required: true
    },
    metadata: {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        licensePlate: String,
        buildingName: String,
        status: String
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Index for faster queries on recent activities
activityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
