import { NextResponse } from 'next/server';
import {
  NOT_AVAILABLE_TO_INTEGRATIONS,
  isDeniedForIntegration,
  isIntegrationToken,
} from './utils/integrationPolicy.js';

/**
 * Integration-token denylist at the edge (#84).
 *
 * withAuth already enforces utils/integrationPolicy.js for every route it
 * wraps. This middleware applies the same denylist to the handful of routes
 * that don't use withAuth (auth/signin, auth/signup, auth/signout,
 * auth/google-token, auth/[...nextauth], plaid/items/hard-delete) so they
 * answer `403 NOT_AVAILABLE_TO_INTEGRATIONS` too.
 *
 * It does no DB access and no token validation — a denied route is denied
 * whether or not the token is valid. Requests without a `bliss_` bearer token
 * pass straight through. Runs on the Edge runtime, so it must import only the
 * pure policy module.
 */
export function middleware(request) {
  if (!isIntegrationToken(request.headers.get('authorization'))) {
    return NextResponse.next();
  }

  if (isDeniedForIntegration(request.nextUrl.pathname, request.method)) {
    return NextResponse.json(
      {
        error: 'This endpoint is not available to integration tokens',
        code: NOT_AVAILABLE_TO_INTEGRATIONS,
      },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
