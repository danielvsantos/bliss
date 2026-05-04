import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll } from 'vitest';

// jsdom doesn't implement matchMedia; stub it so useIsMobile can detect viewport
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarInset,
  SidebarInput,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from './sidebar';

// Basic wrapper for all sidebar tests
const SidebarWrapper = ({ children, defaultOpen = true }: { children: React.ReactNode; defaultOpen?: boolean }) => (
  <SidebarProvider defaultOpen={defaultOpen}>{children}</SidebarProvider>
);

describe('SidebarProvider', () => {
  it('renders children', () => {
    render(
      <SidebarProvider>
        <div data-testid="child">Hello</div>
      </SidebarProvider>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('accepts custom className', () => {
    const { container } = render(
      <SidebarProvider className="custom-provider">
        <div>content</div>
      </SidebarProvider>
    );
    expect(container.querySelector('.custom-provider')).toBeInTheDocument();
  });
});

describe('Sidebar', () => {
  it('renders a sidebar', () => {
    render(
      <SidebarWrapper>
        <Sidebar data-testid="sidebar">
          <SidebarContent>
            <p>Sidebar content</p>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByText('Sidebar content')).toBeInTheDocument();
  });

  it('renders sidebar with variant="floating"', () => {
    render(
      <SidebarWrapper>
        <Sidebar variant="floating">
          <SidebarContent>Floating</SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByText('Floating')).toBeInTheDocument();
  });

  it('renders sidebar with variant="inset"', () => {
    render(
      <SidebarWrapper>
        <Sidebar variant="inset">
          <SidebarContent>Inset</SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByText('Inset')).toBeInTheDocument();
  });

  it('renders sidebar on the right side', () => {
    render(
      <SidebarWrapper>
        <Sidebar side="right">
          <SidebarContent>Right sidebar</SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByText('Right sidebar')).toBeInTheDocument();
  });
});

describe('SidebarTrigger', () => {
  it('renders a toggle button', () => {
    render(
      <SidebarWrapper>
        <SidebarTrigger data-testid="trigger" />
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('trigger')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(
      <SidebarWrapper>
        <SidebarTrigger data-testid="trigger" onClick={onClick} />
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    fireEvent.click(screen.getByTestId('trigger'));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('SidebarHeader and SidebarFooter', () => {
  it('renders SidebarHeader', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarHeader data-testid="header">Header content</SidebarHeader>
          <SidebarContent>Body</SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('header')).toBeInTheDocument();
    expect(screen.getByText('Header content')).toBeInTheDocument();
  });

  it('renders SidebarFooter', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>Body</SidebarContent>
          <SidebarFooter data-testid="footer">Footer content</SidebarFooter>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('footer')).toBeInTheDocument();
  });
});

describe('SidebarGroup and related', () => {
  it('renders SidebarGroup with label and content', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Navigation</SidebarGroupLabel>
              <SidebarGroupContent>
                <p>Nav items</p>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('Nav items')).toBeInTheDocument();
  });

  it('renders SidebarGroupAction', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Group</SidebarGroupLabel>
              <SidebarGroupAction data-testid="group-action">+</SidebarGroupAction>
              <SidebarGroupContent>Items</SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('group-action')).toBeInTheDocument();
  });
});

describe('SidebarMenu and items', () => {
  it('renders menu with items and buttons', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Menu</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Dashboard</SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Transactions</SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
  });

  it('renders SidebarMenuButton as active', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive data-testid="active-btn">Active</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('active-btn')).toHaveAttribute('data-active', 'true');
  });

  it('renders SidebarMenuButton as link', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/dashboard" data-testid="link-btn">Link</a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('link-btn')).toBeInTheDocument();
  });

  it('renders SidebarMenuAction', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>Item</SidebarMenuButton>
                <SidebarMenuAction data-testid="action">•••</SidebarMenuAction>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('action')).toBeInTheDocument();
  });

  it('renders SidebarMenuBadge', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>Inbox</SidebarMenuButton>
                <SidebarMenuBadge data-testid="badge">5</SidebarMenuBadge>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('badge')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});

describe('SidebarMenuSkeleton', () => {
  it('renders skeleton without icon', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuSkeleton data-testid="skeleton" />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  it('renders skeleton with icon', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuSkeleton showIcon data-testid="skeleton-icon" />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('skeleton-icon')).toBeInTheDocument();
  });
});

describe('SidebarMenuSub', () => {
  it('renders sub-menu', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>Parent</SidebarMenuButton>
                <SidebarMenuSub>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton>Child 1</SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton isActive>Child 2 (active)</SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByText('Child 1')).toBeInTheDocument();
    expect(screen.getByText('Child 2 (active)')).toBeInTheDocument();
  });
});

describe('SidebarInset', () => {
  it('renders inset main area', () => {
    render(
      <SidebarWrapper>
        <SidebarInset data-testid="inset">
          <p>Main content area</p>
        </SidebarInset>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('inset')).toBeInTheDocument();
    expect(screen.getByText('Main content area')).toBeInTheDocument();
  });
});

describe('SidebarInput', () => {
  it('renders an input inside the sidebar', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarHeader>
            <SidebarInput placeholder="Search..." data-testid="sidebar-input" />
          </SidebarHeader>
          <SidebarContent>Content</SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('sidebar-input')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
  });
});

describe('SidebarRail', () => {
  it('renders a rail', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>Content</SidebarContent>
          <SidebarRail data-testid="rail" />
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('rail')).toBeInTheDocument();
  });
});

describe('SidebarSeparator', () => {
  it('renders a separator', () => {
    render(
      <SidebarWrapper>
        <Sidebar>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>G1</SidebarGroupLabel>
              <SidebarGroupContent>Items</SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator data-testid="separator" />
          </SidebarContent>
        </Sidebar>
      </SidebarWrapper>
    );
    expect(screen.getByTestId('separator')).toBeInTheDocument();
  });
});

describe('useSidebar', () => {
  it('throws when used outside SidebarProvider', () => {
    const Component = () => { useSidebar(); return null; };
    expect(() => render(<Component />)).toThrow('useSidebar must be used within a SidebarProvider');
  });

  it('returns sidebar state inside provider', () => {
    let sidebarCtx: ReturnType<typeof useSidebar> | undefined;
    const Component = () => {
      sidebarCtx = useSidebar();
      return null;
    };
    render(
      <SidebarProvider defaultOpen={true}>
        <Component />
      </SidebarProvider>
    );
    expect(sidebarCtx).toBeDefined();
    expect(sidebarCtx!.open).toBe(true);
    expect(typeof sidebarCtx!.toggleSidebar).toBe('function');
  });

  it('toggleSidebar changes open state', () => {
    let sidebarCtx: ReturnType<typeof useSidebar> | undefined;
    const Component = () => {
      sidebarCtx = useSidebar();
      return null;
    };
    render(
      <SidebarProvider defaultOpen={true}>
        <Component />
      </SidebarProvider>
    );
    expect(sidebarCtx!.open).toBe(true);
    act(() => { sidebarCtx!.toggleSidebar(); });
    expect(sidebarCtx!.open).toBe(false);
  });
});
