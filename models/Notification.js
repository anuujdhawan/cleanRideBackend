const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    recipientRole: {
        type: String,
        enum: ['admin', 'cleaner', 'client', 'developer'],
        required: true
    },
    title: {
        type: String,
        required: true
    },
    message: {
        type: String,
        required: true
    },
    read: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Notification', notificationSchema);
