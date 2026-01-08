const validate = (schema) => (req, res, next) => {
    try {
        // If the request is multipart/form-data, the body might be different or need parsing.
        // However, multer should have already populated req.body.
        // We need to handle cases where numbers might be strings in FormData.

        // For now, we assume req.body is populated.
        schema.parse(req.body);
        next();
    } catch (error) {
        if (error.errors) {
            // Format Zod errors
            const errorMessages = error.errors.map(err => ({
                field: err.path.join('.'),
                message: err.message
            }));
            return res.status(400).json({
                message: 'Validation failed',
                errors: errorMessages,
                // Also return a single string message for simple clients
                error: errorMessages[0].message
            });
        }
        return res.status(400).json({ message: error.message });
    }
};

module.exports = validate;
