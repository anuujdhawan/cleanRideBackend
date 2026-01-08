const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function check() {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/carCleanerDB');
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('Collections in DB:', collections.map(c => c.name));
    process.exit(0);
}
check();
