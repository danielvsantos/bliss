module.exports = {
  name: 'DEBT_PAYOFF_TRAJECTORY',
  rubric: `DEBT_PAYOFF_TRAJECTORY
Focus: months-to-payoff at current pace, per debt instrument.
Severity:
- WARNING:  payoff date moved later vs prior quarter (slipping).
- INFO:     payoff date stable.
- POSITIVE: payoff date moved earlier ≥2 months (accelerating).
For revolving debt (credit cards, lines of credit), only project a trajectory when the user has paid more than the minimum for ≥2 consecutive months. Otherwise the projection is meaningless.
Treat mortgages as debt for total-debt context, but never frame a mortgage's standard amortization as a "trajectory issue" — only flag mortgages here when the user has clearly accelerated or skipped payments.`,
};
