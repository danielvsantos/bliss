import { allowedOrigins } from './allowedOrigins.js';

// Middleware to handle CORS
export function cors(req, res) {
  const allowed = allowedOrigins();

  const origin = req.headers.origin;

  // Only set Access-Control-Allow-Origin if origin is in our allowed list
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Only set credentials header if we're allowing the origin
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Required headers for preflight requests
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  // Allowed HTTP methods
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
} 