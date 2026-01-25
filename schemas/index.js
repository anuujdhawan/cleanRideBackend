const z = require('zod');

const registerSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    username: z.string().min(3, 'Username must be at least 3 characters'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    phone: z.string().min(10, 'Phone number must be at least 10 digits'),
    role: z.enum(['client', 'cleaner', 'admin', 'developer']).optional().default('client'),
    buildingName: z.string().optional(),
    floorNumber: z.string().optional(),
    parkingSlot: z.string().optional(),
    secretQuestion: z.string().min(1, 'Secret question is required').optional(),
    secretAnswer: z.string().min(1, 'Secret answer is required').optional(),
    adminSecretCode: z.string().optional(),
    buildingAssigned: z.string().optional(),
}).refine((data) => {
    if (data.role === 'client') {
        return !!data.buildingName && !!data.floorNumber && !!data.parkingSlot;
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
    apartmentNumber: z.string().min(1, 'Apartment number is required'),
});

const profileUpdateSchema = z.object({
    name: z.string().min(1, 'Name is required').optional(),
    email: z.string().email('Invalid email address').optional(),
    phone: z.string().regex(/^\d{10,}$/, 'Phone number must be at least 10 digits and contain only numbers').optional(),
}).refine((data) => Object.keys(data).length > 0, {
    message: "At least one profile field is required",
    path: ["name"]
});

module.exports = {
    registerSchema,
    loginSchema,
    carSchema,
    profileUpdateSchema,
};
