// Mock all external dependencies before requiring the module under test
jest.mock('../../../utils/descriptionCache', () => ({
  lookupDescription: jest.fn(),
  addDescriptionEntry: jest.fn(),
}));

jest.mock('../../../utils/categoryCache', () => ({
  getCategoriesForTenant: jest.fn(),
}));

jest.mock('../../../services/llm', () => ({
  generateEmbedding: jest.fn(),
  classifyTransaction: jest.fn(),
}));

jest.mock('../../../../prisma/prisma', () => ({
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { lookupDescription, addDescriptionEntry } = require('../../../utils/descriptionCache');
const { getCategoriesForTenant } = require('../../../utils/categoryCache');
const geminiService = require('../../../services/llm');
const prisma = require('../../../../prisma/prisma');

const { classify, recordFeedback } = require('../../../services/categorizationService');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_EMBEDDING = new Array(768).fill(0.1);
const MOCK_CATEGORIES = [
  { id: 1, name: 'Food & Dining', type: 'EXPENSE' },
  { id: 2, name: 'Transport', type: 'EXPENSE' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('categorizationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no exact match, no vector match, LLM succeeds
    lookupDescription.mockResolvedValue(null);
    geminiService.generateEmbedding.mockResolvedValue(MOCK_EMBEDDING);
    prisma.$queryRaw.mockResolvedValue([]);
    getCategoriesForTenant.mockResolvedValue(MOCK_CATEGORIES);
    geminiService.classifyTransaction.mockResolvedValue({
      categoryId: 1,
      confidence: 0.88,
      reasoning: 'Looks like food',
    });
  });

  describe('classify() — Tier 1: EXACT_MATCH', () => {
    it('returns EXACT_MATCH result when the description cache has a hit', async () => {
      lookupDescription.mockResolvedValue(5);
      const result = await classify('Starbucks', null, 'tenant1');
      expect(result.categoryId).toBe(5);
      expect(result.source).toBe('EXACT_MATCH');
      expect(result.confidence).toBe(1);
    });

    it('does not call Gemini when an exact match is found', async () => {
      lookupDescription.mockResolvedValue(5);
      await classify('Starbucks', null, 'tenant1');
      expect(geminiService.generateEmbedding).not.toHaveBeenCalled();
      expect(geminiService.classifyTransaction).not.toHaveBeenCalled();
    });
  });

  describe('classify() — Tier 2: VECTOR_MATCH', () => {
    it('returns VECTOR_MATCH when similarity is at or above the threshold', async () => {
      prisma.$queryRaw.mockResolvedValue([{ categoryId: 3, similarity: 0.85 }]);
      const result = await classify('Coffee Shop', null, 'tenant1', 0.70);
      expect(result.categoryId).toBe(3);
      expect(result.source).toBe('VECTOR_MATCH');
      expect(result.confidence).toBeCloseTo(0.85);
    });

    it('falls through to LLM when vector similarity is below the threshold', async () => {
      prisma.$queryRaw.mockResolvedValue([{ categoryId: 3, similarity: 0.50 }]);
      const result = await classify('Coffee Shop', null, 'tenant1', 0.70);
      expect(result.source).toBe('LLM');
    });
  });

  describe('classify() — Tier 3: LLM', () => {
    it('returns LLM result when both cache and vector tiers miss', async () => {
      const result = await classify('Brand New Store', 'New Merchant', 'tenant1');
      expect(result.categoryId).toBe(1);
      expect(result.source).toBe('LLM');
      expect(result.reasoning).toBe('Looks like food');
    });

    it('throws when description or tenantId is missing', async () => {
      await expect(classify('', null, 'tenant1')).rejects.toThrow();
      await expect(classify('Starbucks', null, '')).rejects.toThrow();
    });

    it('throws with a meaningful message when all tiers fail', async () => {
      geminiService.classifyTransaction.mockRejectedValue(new Error('LLM down'));
      await expect(classify('Weird Store', null, 'tenant1')).rejects.toThrow(
        'All classification tiers failed'
      );
    });
  });

  describe('recordFeedback()', () => {
    it('calls addDescriptionEntry synchronously with the correct arguments', async () => {
      await recordFeedback('Uber', 7, 'tenant1', 42);
      expect(addDescriptionEntry).toHaveBeenCalledWith('Uber', 7, 'tenant1');
    });

    it('initiates generateEmbedding as a fire-and-forget call', async () => {
      await recordFeedback('Uber', 7, 'tenant1');
      expect(geminiService.generateEmbedding).toHaveBeenCalledWith('Uber');
    });

    it('does not throw when embedding generation fails', async () => {
      geminiService.generateEmbedding.mockRejectedValue(new Error('API error'));
      await expect(recordFeedback('Uber', 7, 'tenant1')).resolves.not.toThrow();
    });

    it('skips cache update and does not throw when required params are missing', async () => {
      await recordFeedback('', 7, 'tenant1');
      expect(addDescriptionEntry).not.toHaveBeenCalled();
    });
  });
});
