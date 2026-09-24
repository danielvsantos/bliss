const express = require('express');
const { StatusCodes } = require('http-status-codes');
const apiKeyAuth = require('../middleware/apiKeyAuth');
const { getRuntimeInfo } = require('../utils/runtimeInfo');
const { readWorkerHeartbeat } = require('../utils/workerHeartbeat');

const router = express.Router();

/**
 * Runtime version reporting for the backend tier.
 *
 * Answers for this process AND for the worker service, which has no HTTP
 * server of its own and publishes to Redis instead (see workerHeartbeat.js).
 * Both are returned together because they are the same image deployed twice —
 * a version skew between them is exactly the kind of half-finished deploy worth
 * catching.
 *
 * Why this is authenticated and NOT part of /health
 * -------------------------------------------------
 * /health and /health/metrics are deliberately unauthenticated so platform
 * health checks can reach them — on Railway, /health is the backend's deploy
 * health check path. Version strings must not go there. Exact runtime and
 * dependency versions are textbook information disclosure: they turn an
 * attacker's untargeted scan into a targeted CVE lookup against a host already
 * known to be vulnerable. That costs an attacker almost nothing and buys them a
 * great deal, so it is reported behind INTERNAL_API_KEY instead.
 *
 * Usage (from inside the private network, or via the API's own /api/runtime):
 *   curl -H "x-api-key: $INTERNAL_API_KEY" http://<backend>/api/runtime
 */
router.use(apiKeyAuth);

router.get('/', async (req, res) => {
  res.status(StatusCodes.OK).json({
    ...getRuntimeInfo('backend-web'),
    worker: await readWorkerHeartbeat(),
  });
});

module.exports = router;
