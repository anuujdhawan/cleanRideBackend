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
const isServerless = Boolean(process.env.VERCEL);
app.set('trust proxy', 1);
app.use(cors());
// app.use(cookieParser());
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URL;
let connectionPromise = null;

const connectToDatabase = async () => {
  if (mongoose.connection.readyState === 1) return;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not configured');
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(mongoUri)
      .then(async () => {
        console.log(`Connected to MongoDB: ${mongoUri}`);
        await seedCarBrands();
      })
      .catch((err) => {
        connectionPromise = null;
        console.error('MongoDB connection error:', err);
        throw err;
      });
  }

  await connectionPromise;
};

if (isServerless) {
  app.use(async (req, res, next) => {
    try {
      await connectToDatabase();
      next();
    } catch (error) {
      next(error);
    }
  });
} else {
  connectToDatabase().catch(() => {});
}

//serverless mongodb connection
// let isConnected = false;
// const connectToDatabase = async () => {
//   if (!isConnected) {
//     try {
//       await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/carCleanerDB');
//       console.log('Connected to MongoDB');
//       await seedCarBrands();
//       isConnected = true;
//     } catch (error) {
//       console.error('MongoDB connection error:', error);
//     }
//   }
// };
// app.use(async (req, res, next) => {
//   if (!isConnected) {
//     await connectToDatabase();
//   }
//   next();
// });

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/client', require('./routes/client'));
app.use('/api/cleaner', require('./routes/cleaner'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/developer', require('./routes/developer'));
app.use('/api/buildings', require('./routes/buildings'));
app.use('/api/brands', require('./routes/brands'));
app.use('/api/payment', require('./routes/payment'));

const port = process.env.PORT || 5000;
if (isServerless) {
  module.exports = app;
} else {
  app.listen(port, () => {
    console.log(`===============>>>Backend Server is running on port ${port}`);
  });
}
