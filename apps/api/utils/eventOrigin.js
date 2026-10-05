/**
 * Event origin for processing status (#100).
 *
 * Spread into a `produceEvent` payload so the backend can label the work it
 * starts: writes made with an integration key (AI agents, MCP) show as
 * "AI agent" in the header chip and the Processing tab. The backend forwards
 * `_trigger` through the whole job chain. Returns `{}` for normal sessions.
 *
 * @param {import('next').NextApiRequest} req
 */
export function eventOrigin(req) {
  return req?.user?.authType === 'integration' ? { _trigger: 'agent' } : {};
}
