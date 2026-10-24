import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InstallMode } from '@/lib/pwa/platform';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const install = vi.fn();
let mode: InstallMode = 'unsupported';
vi.mock('@/hooks/use-install-prompt', () => ({
  useInstallPrompt: () => ({ mode, install }),
}));

import { InstallAppButton } from './install-app-button';
import { InstallBanner, INSTALL_BANNER_DISMISSED_KEY } from './install-banner';
import { InstallAppCard } from './install-app-card';

describe('Install app control (#155)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('iOS: opens the Add to Home Screen steps, ending with the sign-in note', () => {
    mode = 'ios-instructions';
    render(<InstallAppButton />);
    fireEvent.click(screen.getByRole('button', { name: /pwa.install.button/ }));
    expect(screen.getByTestId('install-instructions')).toBeInTheDocument();
    expect(screen.getByText('pwa.install.iosStep1')).toBeInTheDocument();
    expect(screen.getByText('pwa.install.iosSignInNote')).toBeInTheDocument();
    expect(install).not.toHaveBeenCalled();
  });

  it('Android / desktop Chrome: triggers the native install prompt', () => {
    mode = 'prompt';
    render(<InstallAppButton />);
    fireEvent.click(screen.getByRole('button', { name: /pwa.install.button/ }));
    expect(install).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('install-instructions')).not.toBeInTheDocument();
  });

  it.each<InstallMode>(['standalone', 'unsupported'])('%s: renders no control, banner or card', (m) => {
    mode = m;
    const { container } = render(
      <>
        <InstallAppButton />
        <InstallBanner />
        <InstallAppCard />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('banner: dismissal is permanent on this device', () => {
    mode = 'prompt';
    const { unmount } = render(<InstallBanner />);
    expect(screen.getByTestId('install-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'pwa.install.dismiss' }));
    expect(screen.queryByTestId('install-banner')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY)).toBe('1');
    unmount();

    // A later visit: still hidden, while the Settings card stays available.
    render(
      <>
        <InstallBanner />
        <InstallAppCard />
      </>,
    );
    expect(screen.queryByTestId('install-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('install-app-card')).toBeInTheDocument();
  });
});
