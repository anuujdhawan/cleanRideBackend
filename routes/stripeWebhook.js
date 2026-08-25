const express = require('express');
const path = require('path');
const router = express.Router();
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const { logActivity } = require('../utils/activityLogger');
const { sendExpoPushNotifications } = require('../utils/expoPush');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let stripe = null;
const stripeKey = process.env.STRIPE_SECRET_KEY;
const STRIPE_API_VERSION = '2023-10-16';

if (stripeKey && stripeKey.startsWith('sk_')) {
    stripe = require('stripe')(stripeKey, { apiVersion: STRIPE_API_VERSION });
} else {
    console.warn('Stripe key is missing or invalid. Stripe webhooks will be ignored.');
}

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const resolveLocalStatusFromStripe = (stripeSubscription) => {
    const stripeStatus = String(stripeSubscription?.status || '').toLowerCase();
    if (stripeStatus === 'canceled' || stripeStatus === 'cancelled') {
        return 'cancelled';
    }
    if (stripeStatus === 'active' || stripeStatus === 'trialing') {
        return stripeSubscription?.pause_collection ? 'on_hold' : 'active';
    }
    return 'inactive';
};

// Mirrors a Stripe subscription's current state onto the local record, if one is already
// linked to it. Subscriptions Stripe created that we haven't linked yet (see the admin
// "unmatched subscriptions" screen) are intentionally left alone here.
const syncLocalSubscriptionFromStripeEvent = async (stripeSubscription, action) => {
    if (!stripeSubscription?.id) return;

    const subscription = await Subscription.findOne({ stripeSubscriptionId: stripeSubscription.id });
    if (!subscription) return;

    const nextStatus = resolveLocalStatusFromStripe(stripeSubscription);
    if (subscription.status === nextStatus) return;

    subscription.status = nextStatus;
    if (nextStatus === 'cancelled') {
        subscription.endDate = new Date();
    } else {
        if (stripeSubscription.current_period_start) {
            subscription.startDate = new Date(stripeSubscription.current_period_start * 1000);
        }
        if (stripeSubscription.current_period_end) {
            subscription.endDate = new Date(stripeSubscription.current_period_end * 1000);
        }
    }

    if (!Array.isArray(subscription.statusHistory)) {
        subscription.statusHistory = [];
    }
    subscription.statusHistory.push({ status: nextStatus, action, timestamp: new Date() });

    await subscription.save();

    await logActivity(
        'subscription_stripe_webhook_sync',
        `Stripe webhook synced subscription ${stripeSubscription.id} to status "${nextStatus}"`,
        { subscriptionId: subscription._id, stripeSubscriptionId: stripeSubscription.id, status: nextStatus }
    );
};

const notifyClientPaymentOutcome = async (subscription, outcome) => {
    try {
        const user = await User.findById(subscription.userId).select('pushToken');
        if (!user?.pushToken) return;

        const message = outcome === 'failed'
            ? {
                to: user.pushToken,
                sound: 'default',
                title: 'Payment Failed',
                body: 'Your car wash subscription payment could not be processed. Please update your payment method to keep your subscription active.',
                data: { type: 'subscription_payment_failed', subscriptionId: String(subscription._id) },
            }
            : {
                to: user.pushToken,
                sound: 'default',
                title: 'Payment Received',
                body: 'Your car wash subscription payment was successful and your subscription is active again.',
                data: { type: 'subscription_payment_succeeded', subscriptionId: String(subscription._id) },
            };

        await sendExpoPushNotifications([message], {
            action: `stripe_invoice_${outcome}`,
            subscriptionId: String(subscription._id)
        });
    } catch (error) {
        console.error('Failed to send payment outcome push notification:', error.message);
    }
};

// A failed/successful renewal charge is reported per-invoice, not on the subscription object
// itself, so this reacts to invoice.payment_failed / invoice.paid rather than waiting on
// customer.subscription.updated (which also fires, but only after Stripe re-evaluates the
// subscription's overall status - this reacts to the specific charge outcome directly).
const applyInvoicePaymentOutcome = async (invoice, outcome) => {
    const stripeSubscriptionId = typeof invoice?.subscription === 'string'
        ? invoice.subscription
        : invoice?.subscription?.id;
    if (!stripeSubscriptionId) return;

    const subscription = await Subscription.findOne({ stripeSubscriptionId });
    if (!subscription) return;

    // Never override a cancellation, and never override an admin-initiated hold based on a
    // stray invoice event - both are deliberate states that outrank a billing outcome.
    if (subscription.status === 'cancelled' || subscription.status === 'on_hold') return;

    const nextStatus = outcome === 'failed' ? 'inactive' : 'active';
    if (subscription.status !== nextStatus) {
        subscription.status = nextStatus;

        if (!Array.isArray(subscription.statusHistory)) {
            subscription.statusHistory = [];
        }
        subscription.statusHistory.push({
            status: nextStatus,
            action: outcome === 'failed' ? 'stripe_webhook_payment_failed' : 'stripe_webhook_payment_recovered',
            timestamp: new Date()
        });

        await subscription.save();

        await logActivity(
            'subscription_stripe_payment_sync',
            outcome === 'failed'
                ? `Payment failed for subscription ${stripeSubscriptionId} - marked inactive`
                : `Payment recovered for subscription ${stripeSubscriptionId} - marked active`,
            { subscriptionId: subscription._id, stripeSubscriptionId, status: nextStatus }
        );
    }

    await notifyClientPaymentOutcome(subscription, outcome);
};

// POST / - mounted at /api/webhooks/stripe in server/index.js
router.post('/', async (req, res) => {
    if (!stripe || !webhookSecret) {
        console.warn('Stripe webhook received but STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET is not configured. Ignoring event.');
        return res.status(200).json({ received: true, skipped: true });
    }

    const signature = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);
    } catch (error) {
        console.error('Stripe webhook signature verification failed:', error.message);
        return res.status(400).json({ message: `Webhook Error: ${error.message}` });
    }

    try {
        switch (event.type) {
            case 'customer.subscription.deleted':
                await syncLocalSubscriptionFromStripeEvent(event.data.object, 'stripe_webhook_cancel');
                break;
            case 'customer.subscription.updated':
                await syncLocalSubscriptionFromStripeEvent(event.data.object, 'stripe_webhook_sync');
                break;
            case 'invoice.payment_failed':
                await applyInvoicePaymentOutcome(event.data.object, 'failed');
                break;
            case 'invoice.paid':
                await applyInvoicePaymentOutcome(event.data.object, 'paid');
                break;
            default:
                break;
        }
    } catch (error) {
        // Still acknowledge receipt below so Stripe doesn't retry-storm; the failure is logged for investigation.
        console.error(`Failed to process Stripe webhook event ${event.type}:`, error.message);
    }

    res.status(200).json({ received: true });
});

module.exports = router;
