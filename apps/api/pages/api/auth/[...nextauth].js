import NextAuthImport from "next-auth";
const NextAuth = NextAuthImport.default || NextAuthImport;
import GoogleProviderImport from "next-auth/providers/google";
import CredentialsProviderImport from "next-auth/providers/credentials";

const GoogleProvider = GoogleProviderImport.default || GoogleProviderImport;
const CredentialsProvider = CredentialsProviderImport.default || CredentialsProviderImport;
import { AuthService } from '../../../services/auth.service';
import { encode, decode } from 'next-auth/jwt';

// Create the NextAuth handler once at module load — identical to the original
// single-arg pattern that providers (GoogleProvider, etc.) rely on.
const nextAuthHandler = NextAuth({
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            profile(profile) {
                return {
                    id: profile.sub,
                    name: profile.name,
                    email: profile.email,
                    image: profile.picture,
                    googleId: profile.sub,
                };
            },
        }),
        CredentialsProvider({
            name: 'Credentials',
            credentials: {
                email: { label: "Email", type: "email", placeholder: "user@example.com" },
                password: { label: "Password", type: "password" }
            },
            async authorize(credentials) {
                if (!credentials?.email || !credentials?.password) {
                    throw new Error('Email and password are required');
                }

                const user = await AuthService.findUserByEmail(credentials.email);

                if (!user || !user.passwordHash || !user.passwordSalt) {
                    throw new Error('Invalid email or password');
                }

                const isValid = await AuthService.verifyPassword(
                    credentials.password,
                    user.passwordHash,
                    user.passwordSalt
                );

                if (!isValid) {
                    throw new Error('Invalid email or password');
                }

                return {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    tenantId: user.tenantId,
                };
            }
        })
    ],
    secret: process.env.NEXTAUTH_SECRET,
    session: {
        strategy: "jwt",
        maxAge: 30 * 24 * 60 * 60, // 30 days
    },
    callbacks: {
        async signIn({ user, account, profile }) {
            if (account.provider === 'google') {
                const { user: googleUser, isNew } = await AuthService.findOrCreateGoogleUser({
                    email: profile.email,
                    name: profile.name,
                    googleId: profile.sub,
                });

                // Update user object with tenant info and new-user flag
                user.id = googleUser.id;
                user.tenantId = googleUser.tenantId;
                user.isNew = isNew;
                return true;
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
