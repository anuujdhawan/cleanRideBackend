const mongoose = require('mongoose');

const carSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  make: {
    type: String,
    required: true
  },
  model: {
    type: String,
    required: true
  },
  year: {
    type: Number,
    required: true
  },
  type: {
    type: String,
    enum: ['hatchback', 'sedan', 'mid-suv', 'large-suv'],
    required: true
  },
  licensePlate: {
    type: String,
    required: true
  },
  color: {
    type: String,
    required: true
  },
  photo: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Car', carSchema);
