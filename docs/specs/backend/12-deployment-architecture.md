# 12. Deployment Architecture & Scaling

This document outlines the deployment and horizontal scaling capabilities of the Bliss Backend Service.

## 12.1. Resource Contention Challenge

The backend service is responsible for both receiving immediate events via Express (e.g., incoming Plaid webhooks, internal analytics events) and performing heavy CPU-bound data crunching via BullMQ (e.g., portfolio valuation, historical analytics rebuilding). 

Because Node.js runs on a single thread, running both of these responsibilities in the same process can lead to resource contention. A heavy portfolio valuation could temporarily block the Node.js event loop, preventing the Express API from acknowledging an incoming webhook in a timely manner, leading to timeouts.

## 12.2. Process Separation (`START_MODE`)

To solve this, the application is designed to be horizontally scalable through **Process Separation**. The entry point (`src/index.js`) accepts a `START_MODE` environment variable that allows the codebase to boot in distinct roles.

### `START_MODE=web` (The API Instance)
- **Role**: Sits completely idle until the Finance API or Plaid hits one of its endpoints. It acts as a lightweight ingestor.
- **Action**: Validates the incoming payload and immediately pushes a job onto the appropriate Redis queue, responding with an HTTP 202 or 200.
- **Scaling**: Highly available but requires minimal CPU or RAM. Can scale horizontally (multiple replicas) to handle spikes in incoming web traffic.

### `START_MODE=worker` (The Worker Instance)
- **Role**: The workhorses of the backend. These instances do not run an HTTP server and are unreachable from the open internet.
- **Action**: They connect to Redis and continuously pop jobs off the BullMQ queues (syncing from Plaid, processing cash, valuing portfolios).
- **Scaling**: Requires high CPU and RAM. To scale the total throughput of the backend, simply increase the number of replicas running in `worker` mode. BullMQ automatically handles distributing the jobs across all active worker instances.

### Default Mode (Local Development)
If `START_MODE` is undefined (or explicitly set to `all`), the application boots **both** the Express server and the BullMQ workers in the same process. This ensures that local development via a simple `npm run dev` remains seamless, without requiring developers to manage multiple terminal windows.

## 12.3. Deploying to PaaS (e.g., Railway)

To deploy this architecture effectively on a Platform-as-a-Service like Railway using a single GitHub repository:

1. **Deploy the Web Service**: Create a service from the repo, name it `bliss-backend-web`, and set the `START_MODE=web` environment variable. Expose this service via a public domain.
2. **Deploy the Worker Service**: Create a second service from the exact same repo, name it `bliss-backend-worker`, and set the `START_MODE=worker` environment variable. Ensure this service does **not** have a public domain generated.
3. **Connect to Shared Resources**: Ensure both services share the exact same `DATABASE_URL` and `REDIS_URL`.

When a code change is pushed to GitHub, both the web and worker instances will automatically rebuild and deploy their respective updates simultaneously.
