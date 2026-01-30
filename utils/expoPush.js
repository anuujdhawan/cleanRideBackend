const { Expo } = require('expo-server-sdk');

const expo = new Expo();

const collectReceiptIds = (tickets) =>
  tickets
    .map((ticket) => ticket && ticket.id)
    .filter(Boolean);

const logTicketErrors = (tickets, context) => {
  tickets.forEach((ticket, idx) => {
    if (ticket?.status === 'error') {
      console.warn('Expo push ticket error', {
        context,
        index: idx,
        message: ticket.message,
        details: ticket.details,
      });
    }
  });
};

const logReceiptErrors = (receipts, context) => {
  Object.entries(receipts || {}).forEach(([receiptId, receipt]) => {
    if (receipt?.status === 'error') {
      console.warn('Expo push receipt error', {
        context,
        receiptId,
        message: receipt.message,
        details: receipt.details,
      });
    }
  });
};

const sendExpoPushNotifications = async (messages, context = {}) => {
  const validMessages = [];
  const invalidTokens = [];

  messages.forEach((message) => {
    if (Expo.isExpoPushToken(message.to)) {
      validMessages.push(message);
    } else {
      invalidTokens.push(message.to);
    }
  });

  if (invalidTokens.length) {
    console.warn('Invalid Expo push tokens', { context, invalidTokens });
  }

  if (!validMessages.length) {
    return { tickets: [], receipts: {} };
  }

  const chunks = expo.chunkPushNotifications(validMessages);
  const tickets = [];

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (error) {
      console.error('Expo push send failed', { context, error: error?.message || error });
    }
  }

  logTicketErrors(tickets, context);

  const receiptIds = collectReceiptIds(tickets);
  const receiptChunks = expo.chunkPushNotificationReceiptIds(receiptIds);
  const receipts = {};

  for (const chunk of receiptChunks) {
    try {
      const chunkReceipts = await expo.getPushNotificationReceiptsAsync(chunk);
      Object.assign(receipts, chunkReceipts);
    } catch (error) {
      console.error('Expo receipt fetch failed', { context, error: error?.message || error });
    }
  }

  logReceiptErrors(receipts, context);

  return { tickets, receipts };
};

module.exports = { sendExpoPushNotifications };
