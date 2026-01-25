const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  username: {
    type: String,
    required: true,
    unique: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  secretQuestion: {
    type: String
  },
  secretAnswer: {
    type: String
  },
  phone: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['client', 'cleaner', 'admin', 'developer'],
    default: 'client'
  },
  buildingAssigned: {
    type: String
  },
  pushToken: {
    type: String
  },
  stripeCustomerId: {
    type: String
  },
  buildingName: {
    type: String
  },
  floorNumber: {
    type: String
  },
  parkingSlot: {
    type: String
  },
  washDays: {
    type: String,
    enum: ['Mon,Wed,Fri', 'Tue,Thu,Sat'],
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', userSchema);
