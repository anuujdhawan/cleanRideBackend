const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const authRoutes = require('./routes/auth');
const { seedCarBrands } = require('./utils/seedCarBrands');

// const cookieParser=require('cookie-parser');

// Ensure env vars load even if the server is started from the project root
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
// app.use(cookieParser());
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

// Connect to MongoDB

// mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URL )
//   .then(async () => {
//     console.log('Connected to MongoDB'+(process.env.MONGODB_URI || process.env.MONGO_URL ));
//     await seedCarBrands();
//   })
//   .catch((err) => console.error('MongoDB connection error:', err));

// Shared MongoDB connection helper (works for serverless + long-lived servers)
let isConnected = false;
let hasSeeded = false;
const connectToDatabase = async () => {
  if (isConnected) return true;
  try {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/carCleanerDB');
    console.log('Connected to MongoDB');
    isConnected = true;
    if (!hasSeeded) {
      await seedCarBrands();
      hasSeeded = true;
    }
    return true;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    return false;
  }
};

// Serverless path: connect lazily per request and fail fast if unavailable
app.use(async (req, res, next) => {
  if (!isConnected) {
    const ok = await connectToDatabase();
    if (!ok) {
      return res.status(503).json({ message: 'Database connection unavailable' });
    }
  }
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/client', require('./routes/client'));
app.use('/api/cleaner', require('./routes/cleaner'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/developer', require('./routes/developer'));
app.use('/api/buildings', require('./routes/buildings'));
app.use('/api/brands', require('./routes/brands'));
app.use('/api/payment', require('./routes/payment'));

const startServer = async () => {
  const ok = await connectToDatabase();
  if (!ok) {
    console.error('Failed to connect to MongoDB. Server will not start.');
    process.exit(1);
  }
  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`===============>>>Backend Server is running on port ${port}`);
  });
};

// Run server normally when executed directly (e.g. Node on a VPS)
if (require.main === module) {
  void startServer();
}

// Export the app for serverless deployment (e.g. Vercel)
module.exports = app;
