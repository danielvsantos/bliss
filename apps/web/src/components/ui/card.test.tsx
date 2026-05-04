import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from './card';

describe('Card components', () => {
  it('renders Card with data-slot', () => {
    render(<Card data-testid="card">content</Card>);
    const card = screen.getByTestId('card');
    expect(card).toHaveAttribute('data-slot', 'card');
  });

  it('renders a full card structure', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>My Title</CardTitle>
          <CardDescription>My Description</CardDescription>
        </CardHeader>
        <CardContent>
          <p>Main content</p>
        </CardContent>
        <CardFooter>
          <button>Footer Action</button>
        </CardFooter>
      </Card>
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByText('My Description')).toBeInTheDocument();
    expect(screen.getByText('Main content')).toBeInTheDocument();
    expect(screen.getByText('Footer Action')).toBeInTheDocument();
  });

  it('CardHeader has correct data-slot', () => {
    render(
      <Card>
        <CardHeader data-testid="header">
          <CardTitle>T</CardTitle>
        </CardHeader>
      </Card>
    );
    expect(screen.getByTestId('header')).toHaveAttribute('data-slot', 'card-header');
  });

  it('CardTitle has correct data-slot', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle data-testid="title">Title</CardTitle>
        </CardHeader>
      </Card>
    );
    expect(screen.getByTestId('title')).toHaveAttribute('data-slot', 'card-title');
  });

  it('CardDescription has correct data-slot', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>T</CardTitle>
          <CardDescription data-testid="desc">Description</CardDescription>
        </CardHeader>
      </Card>
    );
    expect(screen.getByTestId('desc')).toHaveAttribute('data-slot', 'card-description');
  });

  it('CardContent has correct data-slot', () => {
    render(
      <Card>
        <CardContent data-testid="content">body</CardContent>
      </Card>
    );
    expect(screen.getByTestId('content')).toHaveAttribute('data-slot', 'card-content');
  });

  it('CardFooter has correct data-slot', () => {
    render(
      <Card>
        <CardFooter data-testid="footer">footer</CardFooter>
      </Card>
    );
    expect(screen.getByTestId('footer')).toHaveAttribute('data-slot', 'card-footer');
  });

  it('CardAction has correct data-slot', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>T</CardTitle>
          <CardAction data-testid="action">action</CardAction>
        </CardHeader>
      </Card>
    );
    expect(screen.getByTestId('action')).toHaveAttribute('data-slot', 'card-action');
  });

  it('applies custom className to Card', () => {
    render(<Card className="my-card" data-testid="card">x</Card>);
    expect(screen.getByTestId('card')).toHaveClass('my-card');
  });
});
