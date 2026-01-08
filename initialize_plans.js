const mongoose = require('mongoose');
const SubscriptionPlan = require('./models/SubscriptionPlan');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/carCleanerDB');

async function initializePlans() {
  try {
    // Define default plans
    const defaultPlans = [
      {
        carType: 'hatchback',
        planType: 'basic',
        price: 100,
        description: 'Basic exterior wash service',
        features: ['Exterior Wash', '3 times per week'],
        washFrequency: '3 times per week'
      },
      {
        carType: 'hatchback',
        planType: 'premium',
        price: 130,
        description: 'Premium wash with interior and tyre polishing',
        features: ['Exterior Wash', 'Interior Wash (once per month)', 'Tyre Polishing (once per month)', '3 times per week'],
        washFrequency: '3 times per week'
      },
      {
        carType: 'sedan',
        planType: 'basic',
        price: 120,
        description: 'Basic exterior wash service',
        features: ['Exterior Wash', '3 times per week'],
        washFrequency: '3 times per week'
      },
      {
        carType: 'sedan',
        planType: 'premium',
        price: 150,
        description: 'Premium wash with interior and tyre polishing',
        features: ['Exterior Wash', 'Interior Wash (once per month)', 'Tyre Polishing (once per month)', '3 times per week'],
        washFrequency: '3 times per week'
      },
      {
        carType: 'mid-suv',
        planType: 'basic',
        price: 130,
        description: 'Basic exterior wash service',
        features: ['Exterior Wash', '3 times per week'],
        washFrequency: '3 times per week'
      },
      {
        carType: 'mid-suv',
        planType: 'premium',
        price: 160,
        description: 'Premium wash with interior and tyre polishing',
        features: ['Exterior Wash', 'Interior Wash (once per month)', 'Tyre Polishing (once per month)', '3 times per week'],
        washFrequency: '3 times per week'
      },
      {
        carType: 'large-suv',
        planType: 'basic',
        price: 150,
        description: 'Basic exterior wash service',
        features: ['Exterior Wash', '3 times per week'],
        washFrequency: '3 times per week'
      },
      {
        carType: 'large-suv',
        planType: 'premium',
        price: 180,
        description: 'Premium wash with interior and tyre polishing',
        features: ['Exterior Wash', 'Interior Wash (once per month)', 'Tyre Polishing (once per month)', '3 times per week'],
        washFrequency: '3 times per week'
      }
    ];

    // Check if plans already exist
    const existingPlans = await SubscriptionPlan.find();
    if (existingPlans.length > 0) {
      console.log('Subscription plans already exist. Skipping initialization.');
      process.exit(0);
    }

    // Insert default plans
    await SubscriptionPlan.insertMany(defaultPlans);
    console.log('Default subscription plans initialized successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error initializing subscription plans:', error);
    process.exit(1);
  }
}

initializePlans();
