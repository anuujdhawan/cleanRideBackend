const ActivityLog = require('../models/ActivityLog');

/**
 * Log an activity to the database
 * @param {string} type - Type of activity (subscription, wash_status, etc.)
 * @param {string} message - Human-readable message
 * @param {object} metadata - Additional data (userId, licensePlate, etc.)
 */
const logActivity = async (type, message, metadata = {}) => {
    try {
        await ActivityLog.create({ type, message, metadata });
        console.log(`Activity logged: ${type} - ${message}`);
    } catch (error) {
        console.error('Failed to log activity:', error);
    }
};

module.exports = { logActivity };
