const db = require('../models/database');

const checkAuth = (req, res, next) => {
    if (req.session.userId) {
        return next();
    }
    res.redirect('/login');
};

const checkSetup = (req, res, next) => {
    db.get('SELECT count(*) as count FROM users', [], (err, row) => {
        if (err) {
            console.error("Database error in checkSetup:", err);
            return next(err);
        }

        if (row.count === 0) {
            if (req.path === '/setup' || req.path.startsWith('/public') || req.path.startsWith('/api/auth')) {
                return next();
            }
            return res.redirect('/setup');
        }

        if (req.path === '/setup') {
            return res.redirect('/login');
        }

        next();
    });
};

module.exports = { checkAuth, checkSetup };
