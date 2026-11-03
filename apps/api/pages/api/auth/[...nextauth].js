import NextAuthImport from "next-auth";
const NextAuth = NextAuthImport.default || NextAuthImport;
import GoogleProviderImport from "next-auth/providers/google";

const GoogleProvider = GoogleProviderImport.default || GoogleProviderImport;
import { AuthService } from '../../../services/auth.service';
import { encode, decode } from 'next-auth/jwt';
import { GOOGLE_EXCHANGE_WINDOW_S } from '../../../utils/googleExchange.js';

// findOrCreateGoogleUser error code → `?error=` code on the auth page.
const GOOGLE_ERROR_CODES = {
    [AuthService.GOOGLE_ACCOUNT_EXISTS]: 'google_account_exists',
    [AuthService.GOOGLE_EMAIL_UNVERIFIED]: 'google_email_unverified',
    [AuthService.SIGNUP_INVITE_REQUIRED]: 'signup_invite_required',
};

const googleOAuthConfigured =!!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// SameSite=None is required when the web frontend and the API are on different
// origins (split-domain deployment). However, SameSite=None cookies also require
// the Secure flag, which means they are silently dropped on plain HTTP. Enabling
// them unconditionally would break self-hosters who run Bliss on HTTP with both
// services behind the same reverse-proxy domain (where SameSite=Lax worked fine).
//
// Gate: only use SameSite=None when NEXTAUTH_URL is HTTPS, which is the only
// context where it is both necessary (cross-origin POST) and permitted (Secure).
const isHttps = (process.env.NEXTAUTH_URL || '').startsWith('https://');

const crossDomainCookies = isHttps ? {
    csrfToken: {
        name: 'next-auth.csrf-token',
        options: { httpOnly: true, sameSite: 'none', path: '/', secure: true },
    },
    callbackUrl: {
        name: 'next-auth.callback-url',
        options: { sameSite: 'none', path: '/', secure: true },
    },
    state: {
        name: 'next-auth.state',
        options: { httpOnly: true, sameSite: 'none', path: '/', secure: true },
    },
    pkceCodeVerifier: {
        name: 'next-auth.pkce.code_verifier',
        options: { httpOnly: true, sameSite: 'none', path: '/', secure: true },
    },
} : undefined;

// Create the NextAuth handler once at module load — identical to the original
// single-arg pattern that providers (GoogleProvider, etc.) rely on.
const nextAuthHandler = NextAuth({
    ...(crossDomainCookies ? { cookies: crossDomainCookies } : {}),
    providers: [
        ...(googleOAuthConfigured ? [GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            profile(profile) {
                return {
                    id: profile.sub,
                    name: profile.name,
                    email: profile.email,
                    image: profile.picture,
                    googleId: profile.sub,
                    // Carried through so findOrCreateGoogleUser can reject an
                    // unverified address. Without this the claim is dropped
                    // here and never reaches the check.
                    emailVerified: profile.email_verified === true,
                };
            },
        })] : []),
        // No credentials provider (#78 R1): email/password sign-in goes through
        // the rate-limited /api/auth/signin only. NextAuth is Google glue.
    ],
    secret: process.env.NEXTAUTH_SECRET,
    session: {
        strategy: "jwt",
        // Single-use glue (#78 R2): the cookie only has to survive the Google
        // round-trip to /api/auth/google-token, which also enforces the window.
        maxAge: GOOGLE_EXCHANGE_WINDOW_S,
    },
    callbacks: {
        async signIn({ user, account, profile }) {
            if (account.provider === 'google') {
                try {
                    const { user: googleUser, isNew } = await AuthService.findOrCreateGoogleUser({
                        email: profile.email,
                        name: profile.name,
                        googleId: profile.sub,
                        emailVerified: profile.email_verified === true,
                    });

                    // Update user object with tenant info and new-user flag
                    user.id = googleUser.id;
                    user.tenantId = googleUser.tenantId;
                    user.isNew = isNew;
                    return true;
                } catch (error) {
                    // Returning a URL string from signIn redirects the browser
                    // there. Each rejection reason gets its own code so the
                    // auth page can say what actually went wrong — "sign in
                    // with your password" is only actionable if the user is
                    // told that is the problem.
                    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
                    const code = GOOGLE_ERROR_CODES[error?.code] ?? 'oauth_failed';
                    return `${frontendUrl}/auth?error=${code}`;
                }
            }
            return true;
        },
        async jwt({ token, user, account }) {
            if (user) {
                token.id = user.id;
                token.tenantId = user.tenantId;
                token.email = user.email;
                token.name = user.name;
                token.isNew = user.isNew;
                // Immutable sign-in time (#78 R2). NextAuth re-issues `iat`
                // on every /api/auth/session read, so google-token checks this
                // claim instead.
                token.signedInAt = Date.now();
            }
            return token;
        },
        async session({ session, token }) {
            session.user.id = token.id;
            session.user.tenantId = token.tenantId;
            session.user.email = token.email;
            session.user.name = token.name;
            return session;
        },
    },
    pages: {
        signIn: (process.env.FRONTEND_URL || 'http://localhost:8080') + '/auth',
        error: (process.env.FRONTEND_URL || 'http://localhost:8080') + '/auth',
    },
    debug: process.env.NODE_ENV === 'development',
});

// Wrap with CORS headers so the frontend can fetch /api/auth/csrf cross-origin
export default async function handler(req, res) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';
    res.setHeader('Access-Control-Allow-Origin', frontendUrl);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    return nextAuthHandler(req, res);
}

export { encode, decode };
