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
});

module.exports = {
    registerSchema,
    loginSchema,
    carSchema,
};
