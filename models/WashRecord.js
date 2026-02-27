const mongoose = require('mongoose');

const washRecordSchema = new mongoose.Schema({
    clientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    carId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Car'
    },
    cleanerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    washDate: {
        type: Date,
        required: true
    },
    // Scheduled day this wash is applied to when completing a previously pending wash.
    washForDate: {
        type: Date
    },
    washTime: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('WashRecord', washRecordSchema);
