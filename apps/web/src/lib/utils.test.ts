import { describe, it, expect } from 'vitest';
import {
  cn,
  formatCurrency,
  formatPercentage,
  formatDate,
  truncateText,
  isPositive,
} from './utils';

describe('cn', () => {
  it('merges tailwind classes correctly', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'extra')).toBe('base extra');
  });

  it('handles empty input', () => {
    expect(cn()).toBe('');
  });
});

describe('formatCurrency', () => {
  it('formats USD by default', () => {
    const result = formatCurrency(1234.56);
    expect(result).toBe('$1,234.56');
  });

  it('respects currency parameter', () => {
    const result = formatCurrency(1000, 'EUR', 'en-US');
    expect(result).toContain('1,000.00');
  });

  it('respects additional options', () => {
    const result = formatCurrency(1234.567, 'USD', 'en-US', { maximumFractionDigits: 0 });
    expect(result).toBe('$1,235');
  });
});

describe('formatPercentage', () => {
  it('formats value / 100 as percentage', () => {
    const result = formatPercentage(50);
    expect(result).toBe('50.0%');
  });

  it('formats decimal percentages', () => {
    const result = formatPercentage(12.5);
    expect(result).toBe('12.5%');
  });
});

describe('formatDate', () => {
  it('formats Date objects', () => {
    const date = new Date(2025, 0, 15); // Jan 15, 2025
    const result = formatDate(date);
    expect(result).toBe('Jan 15, 2025');
  });

  it('formats string dates', () => {
    const result = formatDate('2025-06-01T00:00:00.000Z');
    // Exact output depends on timezone, but should contain the year
    expect(result).toContain('2025');
  });

  it('formats with custom options', () => {
    const date = new Date(2025, 5, 15);
    const result = formatDate(date, { year: 'numeric', month: 'long' });
    expect(result).toBe('June 2025');
  });
});

describe('truncateText', () => {
  it('returns original if under maxLength', () => {
    expect(truncateText('hello', 10)).toBe('hello');
  });

  it('returns original if exactly maxLength', () => {
    expect(truncateText('hello', 5)).toBe('hello');
  });

  it('truncates and adds ellipsis', () => {
    expect(truncateText('hello world', 5)).toBe('hello...');
  });
});

describe('isPositive', () => {
  it('returns true for positive numbers', () => {
    expect(isPositive(5)).toBe(true);
    expect(isPositive(0.1)).toBe(true);
  });

  it('returns true for zero', () => {
    expect(isPositive(0)).toBe(true);
  });

  it('returns false for negative numbers', () => {
    expect(isPositive(-1)).toBe(false);
    expect(isPositive(-0.001)).toBe(false);
  });
});
