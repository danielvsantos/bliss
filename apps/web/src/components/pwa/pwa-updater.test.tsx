import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const applyPwaUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pwa/register', () => ({
  PWA_NEED_REFRESH_EVENT: 'pwa:need-refresh',
  applyPwaUpdate: () => applyPwaUpdate(),
}));

import { Toaster } from '@/components/ui/toaster';
import { PwaUpdater } from './pwa-updater';

describe('PwaUpdater (#155)', () => {
  it('shows the new-version toast and reloads into the new build on Reload', () => {
    render(
      <>
        <Toaster />
        <PwaUpdater />
      </>,
    );
    expect(screen.queryByText('notifications.info.newVersion')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('pwa:need-refresh'));
    });
    expect(screen.getByText('notifications.info.newVersion')).toBeInTheDocument();

    fireEvent.click(screen.getByText('pwa.update.reload'));
    expect(applyPwaUpdate).toHaveBeenCalledTimes(1);
  });
});
