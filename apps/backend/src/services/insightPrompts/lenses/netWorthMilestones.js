module.exports = {
  name: 'NET_WORTH_MILESTONES',
  rubric: `NET_WORTH_MILESTONES
Focus: proximity to round-number milestones ($25k, $50k, $100k, $250k, $500k, $1M, then every $500k thereafter).
Severity:
- POSITIVE: a milestone was crossed this period.
- INFO:     within 10% of the next milestone.
- (no WARNING/CRITICAL — milestones are positive markers; missing one is not a concern in itself.)
Express both the milestone and the current pace ETA when one is reasonable. Skip the ETA when the savings rate is volatile enough to make the projection meaningless. Celebrate plainly when crossed — no exclamation points, but acknowledge the moment.`,
};
