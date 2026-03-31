const express = require('express');
const { getLatestPrice } = require('../services/priceService');
const logger = require('../utils/logger');
const { StatusCodes } = require('http-status-codes');
const apiKeyAuth = require('../middleware/apiKeyAuth');

const router = express.Router();

// Secure all routes in this file with API key authentication
router.use(apiKeyAuth);

/**
 * GET /prices
 * Fetches the latest price for a given asset.
 * Query Parameters:
 *  - symbol: The asset's ticker or symbol (e.g., 'AAPL', 'bitcoin'). Required.
 *  - assetType: The type of the asset (e.g., 'Equity', 'Crypto'). Required.
 *  - currency: Quote currency for crypto pairs (e.g., 'USD'). Optional.
 *  - exchange: ISO-10383 MIC code for exchange disambiguation (e.g., 'XPAR'). Optional.
 */
router.get('/prices', async (req, res) => {
  const { symbol, assetType, currency, exchange } = req.query;

  if (!symbol || !assetType) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Missing required query parameters: symbol and assetType'
    });
  }

  try {
    const priceData = await getLatestPrice(symbol, assetType, currency, { exchange });

    if (priceData) {
      res.status(StatusCodes.OK).json(priceData);
    } else {
      res.status(StatusCodes.NOT_FOUND).json({ 
        error: `Price not found for symbol ${symbol}` 
      });
    }
  } catch (error) {
    logger.error(`[API] Error in /prices endpoint for ${symbol}: ${error.message}`);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'An internal error occurred while fetching the price.' 
    });
  }
});

module.exports = router; 