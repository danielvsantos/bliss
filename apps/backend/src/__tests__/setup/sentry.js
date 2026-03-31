jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setupExpressErrorHandler: jest.fn(),
  prismaIntegration: jest.fn(),
}));
