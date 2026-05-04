import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';

describe('Tabs components', () => {
  it('renders Tabs root', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );
    expect(screen.getByText('Tab 1')).toBeInTheDocument();
    expect(screen.getByText('Tab 2')).toBeInTheDocument();
  });

  it('shows the default tab content', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );
    expect(screen.getByText('Content 1')).toBeInTheDocument();
  });

  it('applies custom className to Tabs', () => {
    const { container } = render(
      <Tabs defaultValue="t1" className="custom-tabs">
        <TabsList>
          <TabsTrigger value="t1">T1</TabsTrigger>
        </TabsList>
        <TabsContent value="t1">C1</TabsContent>
      </Tabs>
    );
    expect(container.querySelector('.custom-tabs')).toBeInTheDocument();
  });

  it('renders TabsList with correct data-slot', () => {
    render(
      <Tabs defaultValue="t1">
        <TabsList data-testid="tabs-list">
          <TabsTrigger value="t1">T1</TabsTrigger>
        </TabsList>
        <TabsContent value="t1">C1</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('tabs-list')).toHaveAttribute('data-slot', 'tabs-list');
  });

  it('renders TabsTrigger with correct data-slot', () => {
    render(
      <Tabs defaultValue="t1">
        <TabsList>
          <TabsTrigger value="t1" data-testid="trigger">T1</TabsTrigger>
        </TabsList>
        <TabsContent value="t1">C1</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-slot', 'tabs-trigger');
  });

  it('renders TabsContent with correct data-slot', () => {
    render(
      <Tabs defaultValue="t1">
        <TabsList>
          <TabsTrigger value="t1">T1</TabsTrigger>
        </TabsList>
        <TabsContent value="t1" data-testid="content">C1</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId('content')).toHaveAttribute('data-slot', 'tabs-content');
  });
});
