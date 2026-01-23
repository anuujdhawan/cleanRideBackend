const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const User = require('../models/User');
const Car = require('../models/Car');
const validate = require('../middleware/validate');
const { registerSchema, loginSchema, carSchema } = require('../schemas');

const router = express.Router();

const getJwtOptionsForRole = (role) => {
  if (role === 'client' || role === 'cleaner') {
    return {};
  }
  return { expiresIn: '1d' };
};

const normalizeCarType = (value) => {
  if (!value) return 'sedan';
  const normalized = String(value).toLowerCase().replace(/_/g, '-');
  if (normalized.includes('hatch')) return 'hatchback';
  if (normalized.includes('large') && normalized.includes('suv')) return 'large-suv';
  if (normalized.includes('mid') && normalized.includes('suv')) return 'mid-suv';
  if (normalized.includes('suv')) return 'mid-suv';
  if (normalized.includes('sedan')) return 'sedan';
  return 'sedan';
};

const carPhotoDir = path.join(__dirname, '..', 'public', 'car-photos');

const ensureCarPhotoDir = () => {
  fs.mkdirSync(carPhotoDir, { recursive: true });
};

const carPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureCarPhotoDir();
    cb(null, carPhotoDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const unique = crypto.randomBytes(16).toString('hex');
    cb(null, `${unique}${ext}`);
  }
});

const carPhotoUpload = multer({
  storage: carPhotoStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

const maybeUploadCarPhoto = (req, res, next) => {
  if (req.is('multipart')) {
    return carPhotoUpload.single('carPhoto')(req, res, next);
  }
  next();
};

// Middleware to verify token
const verifyToken = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key', { ignoreExpiration: true });
    const role = decoded?.role;
    if (role !== 'client' && role !== 'cleaner') {
      if (!decoded?.exp) {
        return res.status(401).json({ message: 'Token expired.' });
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (decoded.exp <= nowSeconds) {
        return res.status(401).json({ message: 'Token expired.' });
      }
    }
    req.user = decoded;
    next();
  } catch (ex) {
    res.status(400).json({ message: 'Invalid token.' });
  }
};

// Register a new user
router.post('/register', maybeUploadCarPhoto, validate(registerSchema), async (req, res) => {
  try {
    const { name, username, email, password, phone, role, buildingAssigned, adminSecretCode, buildingName, floorNumber, parkingSlot } = req.body;
    const resolvedRole = role || 'client';

    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    if (resolvedRole === 'developer') {
      return res.status(400).json({ message: 'Developer accounts must be created by an admin.' });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // For cleaner registration, verify admin secret code
    if (resolvedRole === 'cleaner' && adminSecretCode !== process.env.ADMIN_SECRET_CODE) {
      return res.status(400).json({ message: 'Invalid admin secret code' });
    }

    // Determine wash days and check for admin notification
    let washDays;
    if (resolvedRole === 'client' && buildingName) {
      const buildingCount = await User.countDocuments({ role: 'client', buildingName });

      // Wash Day Logic: 0-49 -> MWF, 50-119 -> TTS, 120+ -> Cycle
      const cycleCount = buildingCount % 120;
      if (cycleCount < 50) {
        washDays = 'Mon,Wed,Fri';
      } else {
        washDays = 'Tue,Thu,Sat';
      }

      // Check for 99th registration (current count is 98, so this will be 99th)
      if (buildingCount === 98) {
        const Notification = require('../models/Notification');
        const newNotification = new Notification({
          recipientRole: 'admin',
          title: 'High Registration Alert',
          message: `Number of registration in ${buildingName} is done please register a new cleaner as soon as possible.`
        });
        await newNotification.save();

        // TODO: Send Push Notification to Admin if token exists
      }
    }

    // Create new user
    const newUser = new User({
      name,
      username,
      email,
      password: hashedPassword,
      phone,
      role: resolvedRole,
      buildingAssigned: resolvedRole === 'cleaner' ? buildingAssigned : undefined,
      buildingName: resolvedRole === 'client' ? buildingName : undefined,
      floorNumber: resolvedRole === 'client' ? floorNumber : undefined,
      parkingSlot: resolvedRole === 'client' ? parkingSlot : undefined,
      washDays: washDays
    });

    const savedUser = await newUser.save();

    let createdCar = null;

    // Generate JWT token
    const token = jwt.sign(
      { userId: savedUser._id, role: savedUser.role },
      process.env.JWT_SECRET || 'fallback_secret_key',
      getJwtOptionsForRole(savedUser.role)
    );

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: savedUser._id,
        name: savedUser.name,
        username: savedUser.username,
        email: savedUser.email,
        role: savedUser.role,
        buildingAssigned: savedUser.buildingAssigned,
        buildingName: savedUser.buildingName,
        floorNumber: savedUser.floorNumber,
        parkingSlot: savedUser.parkingSlot
      },
      car: createdCar
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

// Login user
router.post('/login', validate(loginSchema), async (req, res) => {
  try {
    const { username, password } = req.body;

    // Find user by username
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET || 'fallback_secret_key',
      getJwtOptionsForRole(user.role)
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        buildingAssigned: user.buildingAssigned,
        buildingName: user.buildingName,
        floorNumber: user.floorNumber,
        parkingSlot: user.parkingSlot
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// Reset password with username/email/phone verification
router.post('/forgot-password', async (req, res) => {
  try {
    const { username, email, phone, newPassword } = req.body;

    if (!username || !email || !phone || !newPassword) {
      return res.status(400).json({ message: 'Username, email, phone, and new password are required' });
    }

    const user = await User.findOne({ username, email, phone });
    if (!user) {
      return res.status(400).json({ message: 'User not found or details do not match' });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
    user.password = hashedPassword;
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ message: 'Server error updating password' });
  }
});

// Get current user profile
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ message: 'Server error fetching profile' });
  }
});

// Create car for user
router.post('/create-car', verifyToken, maybeUploadCarPhoto, validate(carSchema), async (req, res) => {
  try {
    const { clientId, make, model, year, type, licensePlate, color, apartmentNumber } = req.body;

    // Verify the user is authorized to create a car for this client
    if (req.user.userId.toString() !== clientId) {
      return res.status(403).json({ message: 'Unauthorized to create car for this user' });
    }

    const Car = require('../models/Car');

    // Create new car
    const newCar = new Car({
      clientId,
      make,
      model,
      year,
      type: normalizeCarType(type),
      licensePlate,
      apartmentNumber,
      color,
      photo: req.file?.filename
    });

    const savedCar = await newCar.save();

    res.status(201).json({ message: 'Car created successfully', car: savedCar });
  } catch (error) {
    console.error('Create car error:', error);
    res.status(500).json({ message: 'Server error creating car' });
  }
});

module.exports = router;
