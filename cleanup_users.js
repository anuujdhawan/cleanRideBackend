const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function cleanup() {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/carCleanerDB');
    const User = require('./models/User');

    // Remove the 'subscription' field from all users
    const result = await User.updateMany({}, { $unset: { subscription: "" } });
    console.log(`Cleaned up ${result.modifiedCount} user documents.`);
    process.exit(0);
}
cleanup();
