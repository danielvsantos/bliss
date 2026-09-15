const { timingSafeCompare } = require('../utils/timingSafeCompare');

/**
 * Guards every internal backend route with INTERNAL_API_KEY.
 *
 * The comparison is constant-time and length-guarded: a wrong key of any
 * length yields 401, never a 500 from timingSafeEqual's length assertion.
 */
module.exports = function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const expected = process.env.INTERNAL_API_KEY;

  if (!apiKey || !expected || !timingSafeCompare(String(apiKey), expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};
