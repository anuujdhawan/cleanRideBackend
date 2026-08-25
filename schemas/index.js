const z = require('zod');

const registerBaseSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    username: z.string().min(3, 'Username must be at least 3 characters'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    phone: z.string().min(9, 'Phone number must be at least 9 digits'),
    role: z.enum(['client', 'cleaner', 'admin', 'developer']).optional().default('client'),
    buildingName: z.string().optional(),
    floorNumber: z.string().optional(),
    apartmentNumber: z.string().optional(),
    secretQuestion: z.string().min(1, 'Secret question is required').optional(),
    secretAnswer: z.string().min(1, 'Secret answer is required').optional(),
    adminSecretCode: z.string().optional(),
    buildingAssigned: z.string().optional(),
    buildingId: z.string().nullable().optional(),
    buildingIds: z.array(z.string()).nullable().optional(),
});

const registerSchema = registerBaseSchema.refine((data) => {
    if (data.role === 'client') {
        return !!data.buildingName && !!data.floorNumber && !!data.apartmentNumber;
    }
    return true;
}, {
    message: "Building details are required for clients",
    path: ["buildingName"] // Attach error to buildingName
}).refine((data) => {
    if (data.role === 'client') {
        return !!data.secretQuestion && !!data.secretAnswer;
    }
    return true;
}, {
    message: "Security question and answer are required for clients",
    path: ["secretQuestion"]
});

const loginSchema = z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
});

const carSchema = z.object({
    clientId: z.string().min(1, 'Client ID is required'),
    make: z.string().min(1, 'Make is required'),
    model: z.string().min(1, 'Model is required'),
    year: z.string().min(4, 'Year must be 4 digits'),
    type: z.string().min(1, 'Type is required'),
    licensePlate: z.string().min(1, 'License plate is required'),
    color: z.string().min(1, 'Color is required'),
    parkingSlot: z.string().min(1, 'Parking slot is required'),
});

const profileUpdateSchema = z.object({
    name: z.string().min(1, 'Name is required').optional(),
    email: z.string().email('Invalid email address').optional(),
    phone: z.string().regex(/^\d{9,}$/, 'Phone number must be at least 9 digits and contain only numbers').optional(),
}).refine((data) => Object.keys(data).length > 0, {
    message: "At least one profile field is required",
    path: ["name"]
});

const updateCarSchema = z.object({
    make: z.string().min(1, 'Make cannot be empty').optional(),
    model: z.string().min(1, 'Model cannot be empty').optional(),
    type: z.string().min(1, 'Type cannot be empty').optional(),
    licensePlate: z.string().min(1, 'License plate cannot be empty').optional(),
    color: z.string().min(1, 'Color cannot be empty').optional(),
    parkingSlot: z.string().min(1, 'Parking slot cannot be empty').optional(),
    removePhoto: z.string().optional(),
}).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required to update the car',
    path: ['make']
});

module.exports = {
    registerSchema,
    registerBaseSchema,
    loginSchema,
    carSchema,
    profileUpdateSchema,
    updateCarSchema,
};
