const parseDate = (value) => {
    if (!value) return null;

    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const emptyRevenueSummary = () => ({
    total: 0,
    newRevenue: 0,
    renewalRevenue: 0,
    chargeCount: 0,
    newChargeCount: 0,
    renewalChargeCount: 0
});

const getSubscriptionAmount = (subscription) => {
    const amount = Number(subscription?.planDetails?.price ?? 0);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
};

const getBillingAnchorDate = (subscription) => {
    const createdAt = parseDate(subscription?.createdAt);
    const startDate = parseDate(subscription?.startDate);

    if (createdAt && startDate) {
        return createdAt < startDate ? createdAt : startDate;
    }

    return createdAt || startDate;
};

const normalizeStatusHistory = (subscription) => {
    const history = Array.isArray(subscription?.statusHistory) ? subscription.statusHistory : [];

    return history
        .map((entry, index) => ({
            index,
            status: String(entry?.status || '').toLowerCase(),
            timestamp: parseDate(entry?.timestamp)
        }))
        .filter((entry) => entry.status && entry.timestamp)
        .sort((a, b) => {
            const timeDelta = a.timestamp.getTime() - b.timestamp.getTime();
            return timeDelta !== 0 ? timeDelta : a.index - b.index;
        });
};

const getEffectiveEndDate = (subscription) => {
    const normalizedStatus = String(subscription?.status || '').toLowerCase();
    if (!['cancelled', 'inactive'].includes(normalizedStatus)) {
        return null;
    }

    const history = normalizeStatusHistory(subscription);
    const latestEndedEntry = [...history]
        .reverse()
        .find((entry) => entry.status === 'cancelled' || entry.status === 'inactive');

    const endDate = parseDate(subscription?.endDate);

    if (latestEndedEntry?.timestamp && endDate) {
        return latestEndedEntry.timestamp < endDate ? latestEndedEntry.timestamp : endDate;
    }

    return latestEndedEntry?.timestamp || endDate;
};

const getHoldPeriods = (subscription, fallbackEndDate) => {
    const history = normalizeStatusHistory(subscription);
    const periods = [];
    let holdStart = null;

    history.forEach((entry) => {
        if (entry.status === 'on_hold') {
            if (!holdStart) {
                holdStart = entry.timestamp;
            }
            return;
        }

        if (holdStart && ['active', 'cancelled', 'inactive'].includes(entry.status)) {
            periods.push({ start: holdStart, end: entry.timestamp });
            holdStart = null;
        }
    });

    if (holdStart) {
        periods.push({ start: holdStart, end: parseDate(fallbackEndDate) });
    }

    return periods;
};

const isWithinHoldPeriod = (date, holdPeriods) => {
    return holdPeriods.some((period) => {
        if (!period?.start) return false;
        if (date < period.start) return false;
        if (!period.end) return true;
        return date < period.end;
    });
};

const addMonthsClamped = (sourceDate, monthOffset) => {
    const baseDate = parseDate(sourceDate);
    if (!baseDate) return null;

    const targetMonth = new Date(
        baseDate.getFullYear(),
        baseDate.getMonth() + monthOffset,
        1,
        baseDate.getHours(),
        baseDate.getMinutes(),
        baseDate.getSeconds(),
        baseDate.getMilliseconds()
    );

    const lastDayOfMonth = new Date(
        targetMonth.getFullYear(),
        targetMonth.getMonth() + 1,
        0
    ).getDate();

    return new Date(
        targetMonth.getFullYear(),
        targetMonth.getMonth(),
        Math.min(baseDate.getDate(), lastDayOfMonth),
        baseDate.getHours(),
        baseDate.getMinutes(),
        baseDate.getSeconds(),
        baseDate.getMilliseconds()
    );
};

const calculateSubscriptionRevenueInRange = (subscription, rangeStart, rangeEnd) => {
    const summary = emptyRevenueSummary();
    const amount = getSubscriptionAmount(subscription);
    const anchorDate = getBillingAnchorDate(subscription);
    const start = parseDate(rangeStart);
    const end = parseDate(rangeEnd);

    if (!amount || !anchorDate || !start || !end || end < start || anchorDate > end) {
        return summary;
    }

    const effectiveEndDate = getEffectiveEndDate(subscription);
    const iterationEndDate = effectiveEndDate && effectiveEndDate < end ? effectiveEndDate : end;

    if (iterationEndDate < start || iterationEndDate < anchorDate) {
        return summary;
    }

    const holdPeriods = getHoldPeriods(subscription, effectiveEndDate || iterationEndDate);
    const maxBillingCycles = 600;

    let billingCycleIndex = 0;
    let chargeDate = anchorDate;

    while (chargeDate && chargeDate <= iterationEndDate && billingCycleIndex < maxBillingCycles) {
        if (chargeDate >= start && !isWithinHoldPeriod(chargeDate, holdPeriods)) {
            summary.total += amount;
            summary.chargeCount += 1;

            if (billingCycleIndex === 0) {
                summary.newRevenue += amount;
                summary.newChargeCount += 1;
            } else {
                summary.renewalRevenue += amount;
                summary.renewalChargeCount += 1;
            }
        }

        billingCycleIndex += 1;
        chargeDate = addMonthsClamped(anchorDate, billingCycleIndex);
    }

    return summary;
};

const summarizeSubscriptionsRevenueInRange = (subscriptions, rangeStart, rangeEnd) => {
    return (Array.isArray(subscriptions) ? subscriptions : []).reduce((aggregate, subscription) => {
        const summary = calculateSubscriptionRevenueInRange(subscription, rangeStart, rangeEnd);

        aggregate.total += summary.total;
        aggregate.newRevenue += summary.newRevenue;
        aggregate.renewalRevenue += summary.renewalRevenue;
        aggregate.chargeCount += summary.chargeCount;
        aggregate.newChargeCount += summary.newChargeCount;
        aggregate.renewalChargeCount += summary.renewalChargeCount;

        return aggregate;
    }, emptyRevenueSummary());
};

module.exports = {
    calculateSubscriptionRevenueInRange,
    summarizeSubscriptionsRevenueInRange
};
