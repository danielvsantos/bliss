# 12. Frontend Deployment

This document specifies the deployment configuration for the Vite React SPA (`apps/web`).

## 12.1. Overview

The frontend is a static single-page application built with Vite and React 18. It is served by nginx in production. There are no server-side runtime dependencies -- all configuration is baked into the bundle at build time.

## 12.2. Docker Build (`Dockerfile.web`)

The frontend uses a 2-stage multi-stage Docker build:

1. **builder** (`node:20-alpine`): Installs dependencies via pnpm (with `--ignore-scripts` since no native modules are needed), then runs `vite build`. The `NEXT_PUBLIC_API_URL` build argument is set as an environment variable so Vite injects it into the bundle.
2. **runner** (`nginx:alpine`): Copies the built assets from `/app/apps/web/dist` to `/usr/share/nginx/html` and applies the custom nginx configuration.

## 12.3. Build Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | The API layer URL embedded into the static bundle. Must be set at **build time**, not runtime. |

This is the only configuration variable for the frontend. All other app behavior is driven by API responses.

Example Docker Compose override for production:
```yaml
web:
  build:
    args:
      NEXT_PUBLIC_API_URL: https://api.example.com
```

## 12.4. Nginx Serving

The custom nginx configuration (`docker/nginx.conf`) provides three key behaviors:

### Gzip Compression
Enabled for text, CSS, JSON, JavaScript, XML, and related MIME types. Minimum body size of 1024 bytes to avoid compressing tiny responses where the overhead exceeds the savings.

### Immutable Asset Caching
The `/assets/` directory is served with aggressive caching headers:
```
Cache-Control: public, immutable
Expires: 1 year
```
Vite uses content-hashed filenames (e.g. `index-a1b2c3d4.js`), so assets are safe to cache indefinitely. When the content changes, the filename changes, and browsers fetch the new version automatically.

### SPA Fallback
All routes that do not match a physical file fall through to `index.html`:
```
try_files $uri $uri/ /index.html
```
This enables client-side routing via React Router. Direct navigation to `/accounts` or `/transactions` will serve `index.html`, and the React app handles the routing.

## 12.5. No Runtime Environment Variables

The frontend has no runtime configuration. The `NEXT_PUBLIC_API_URL` is the only external value, and it is embedded at build time by Vite's `import.meta.env` mechanism. To change the API URL, the frontend must be rebuilt.

This means:
- No server-side rendering or environment variable injection at startup
- The same built assets can be served from any static hosting (CDN, S3, nginx)
- Cache invalidation is handled entirely by Vite's content-hashed filenames

## 12.6. Alternative Deployment Targets

The Vite build output (`apps/web/dist/`) is a standard static site and can be deployed to:

- **Vercel**: Zero-config static deployment with automatic CDN
- **Netlify**: Static site with `_redirects` file for SPA fallback (`/* /index.html 200`)
- **AWS S3 + CloudFront**: Upload dist to S3, configure CloudFront with custom error response for SPA routing
- **Any static file server**: Serve the `dist/` directory with a fallback to `index.html` for unknown routes

In all cases, ensure the `NEXT_PUBLIC_API_URL` build argument points to the correct API URL at build time.
