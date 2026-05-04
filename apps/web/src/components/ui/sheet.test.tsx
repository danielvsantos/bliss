import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  SheetClose,
} from './sheet';

describe('Sheet components', () => {
  it('renders a closed sheet with trigger', () => {
    render(
      <Sheet>
        <SheetTrigger data-testid="trigger">Open</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Sheet Title</SheetTitle>
            <SheetDescription>Sheet Description</SheetDescription>
          </SheetHeader>
          <p>Sheet body</p>
          <SheetFooter>
            <SheetClose data-testid="close-btn">Close</SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
    expect(screen.getByTestId('trigger')).toBeInTheDocument();
  });

  it('opens sheet when trigger is clicked', () => {
    render(
      <Sheet>
        <SheetTrigger data-testid="trigger">Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>My Sheet</SheetTitle>
            <SheetDescription>Content here</SheetDescription>
          </SheetHeader>
          <p data-testid="body">Body content</p>
        </SheetContent>
      </Sheet>
    );
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.getByText('My Sheet')).toBeInTheDocument();
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('renders with different sides', () => {
    render(
      <Sheet defaultOpen>
        <SheetContent side="left" data-testid="sheet-left">
          <SheetHeader>
            <SheetTitle>Left sheet</SheetTitle>
            <SheetDescription>Left side</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    );
    expect(screen.getByText('Left sheet')).toBeInTheDocument();
  });

  it('renders sheet open by default when defaultOpen=true', () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Open by default</SheetTitle>
            <SheetDescription>Default open state</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    );
    expect(screen.getByText('Open by default')).toBeInTheDocument();
  });

  it('SheetHeader renders children', () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetHeader data-testid="header">
            <SheetTitle>Title in header</SheetTitle>
            <SheetDescription>Description in header</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    );
    expect(screen.getByTestId('header')).toBeInTheDocument();
    expect(screen.getByText('Title in header')).toBeInTheDocument();
  });

  it('SheetFooter renders children', () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>T</SheetTitle>
            <SheetDescription>D</SheetDescription>
          </SheetHeader>
          <SheetFooter data-testid="footer">
            <button>Action</button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
    expect(screen.getByTestId('footer')).toBeInTheDocument();
    expect(screen.getByText('Action')).toBeInTheDocument();
  });
});
