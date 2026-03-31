import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const { checkSession } = useAuth();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const isNew = params.get("isNew");

    // The auth cookie was set server-side by google-token.js.
    // Just verify the session and redirect accordingly.
    checkSession().then(() => {
      if (isNew === "true") {
        navigate("/onboarding", { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    }).catch(() => {
      navigate("/auth?error=oauth_failed", { replace: true });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}
