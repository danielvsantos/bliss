import { SessionProvider, useSession, signIn } from "next-auth/react";
import "../styles/globals.css";
import "bootstrap/dist/css/bootstrap.min.css";
import { useRouter } from "next/router";
import { useEffect } from "react";

function AuthWrapper({ children }) {
  const { data: session, status } = useSession();
  const router = useRouter();

  const publicPaths = ["/auth/login"];
  const isPublicPage = publicPaths.includes(router.pathname);

  useEffect(() => {
    if (!isPublicPage && status === "unauthenticated") {
      router.push("/auth/login");
    }
  }, [status, isPublicPage, router]);

  if (status === "loading") return <p>Loading...</p>;

  if (!session && !isPublicPage) {
    return (
      <p>
        Please{" "}
        <a href="#" onClick={() => signIn("google")}>
          login
        </a>{" "}
        to access.
      </p>
    );
  }

  return <>{children}</>;
}

export default function App({ Component, pageProps }) {
  return (
    <SessionProvider session={pageProps.session}>
      <AuthWrapper>
        <Component {...pageProps} />
      </AuthWrapper>
    </SessionProvider>
  );
}
