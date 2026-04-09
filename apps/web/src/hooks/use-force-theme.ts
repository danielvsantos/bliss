import { useEffect } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { useLocation } from 'react-router-dom';

export function useForceTheme() {
  const { setTheme } = useTheme();
  const location = useLocation();
  const isAuthPage = location.pathname === "/auth";

  useEffect(() => {
    if (isAuthPage) {
      setTheme("light");
    }
  }, [isAuthPage, setTheme]);

  return null;
} 