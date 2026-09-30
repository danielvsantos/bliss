import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { authPathFor } from '@/lib/return-to';

export function withAuth<P extends object>(WrappedComponent: React.ComponentType<P>) {
  return function WithAuthComponent(props: P) {
    const { user, loading } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => {
      if (!loading && !user) {
        // Come back here after sign-in (e.g. the OAuth consent page, #89).
        navigate(authPathFor(`${location.pathname}${location.search}`), { replace: true });
      }
    }, [user, loading, navigate, location.pathname, location.search]);

    if (loading) {
      return (
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-b-2 border-indigo-500"></div>
        </div>
      );
    }

    if (!user) {
      return null; // Don't render anything while redirecting
    }

    return <WrappedComponent {...props} />;
  };
} 