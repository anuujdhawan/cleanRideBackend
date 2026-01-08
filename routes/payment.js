const express = require('express');
const path = require('path');
const router = express.Router();

// Load env from the server folder even when started elsewhere
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Install and configure the Stripe Node library
// npm install stripe
let stripe = null;
const STRIPE_API_VERSION = '2023-10-16';
try {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey && stripeKey.startsWith('sk_') && !stripeKey.includes('...')) {
    stripe = require('stripe')(stripeKey, { apiVersion: STRIPE_API_VERSION });
    console.log('Stripe initialized successfully');
  } else {
    console.warn('Stripe key is missing or invalid. Stripe will run in mock mode.');
  }
} catch (error) {
  console.error('Failed to initialize Stripe:', error.message);
  stripe = null;
}

// POST /create-payment-intent
router.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency } = req.body;

    if (!stripe) {
      // If Stripe is not configured, return mock data for development
      console.warn('Stripe is not configured. Using mock payment intent for development.');

      // Create a mock client secret with proper format that matches Stripe's format
      const mockId = `pi_${Math.random().toString(36).substring(2, 17)}`;
      const mockSecret = `${mockId}_secret_${Math.random().toString(36).substring(2, 32)}`;

      res.json({
        paymentIntent: {
          id: mockId,
          client_secret: mockSecret,
          amount: amount,
          currency: currency || 'aed',
        },
        isMock: true
      });
      return;
    }

    // Create a payment intent using the Stripe API
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // Amount in smallest currency unit (e.g., fils for AED)
      currency: currency || 'aed',
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({
      paymentIntent: {
        id: paymentIntent.id,
        client_secret: paymentIntent.client_secret,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
      },
      isMock: false
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
