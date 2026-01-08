const mongoose = require('mongoose');

const carBrandSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    models: {
        type: [
            {
                name: { type: String, trim: true },
                carType: {
                    type: String,
                    enum: ['hatchback', 'sedan', 'mid-suv', 'large-suv']
                }
            }
        ],
        default: []
    },
    logoFile: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('CarBrand', carBrandSchema);
