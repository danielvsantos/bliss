import { describe, it, expect } from 'vitest';
import { computeTrendMovingAverages } from './trend-utils';

describe('computeTrendMovingAverages', () => {
  it('adds no __avg keys when there are fewer than 6 rows (the default window)', () => {
    const rows = [
      { name: '2023-01', 'Dining Out': 100 },
      { name: '2023-02', 'Dining Out': 200 },
      { name: '2023-03', 'Dining Out': 300 },
      { name: '2023-04', 'Dining Out': 400 },
      { name: '2023-05', 'Dining Out': 500 },
    ];
    const result = computeTrendMovingAverages(rows, ['Dining Out']);
    expect(result).toEqual(rows);
    result.forEach(row => expect(row).not.toHaveProperty('Dining Out__avg'));
  });

  it('adds the average only from the 6th row onward, computed over the trailing window', () => {
    const rows = [
      { name: '2023-01', 'Dining Out': 100 },
      { name: '2023-02', 'Dining Out': 200 },
      { name: '2023-03', 'Dining Out': 300 },
      { name: '2023-04', 'Dining Out': 400 },
      { name: '2023-05', 'Dining Out': 500 },
      { name: '2023-06', 'Dining Out': 600 },
    ];
    const result = computeTrendMovingAverages(rows, ['Dining Out']);
    for (let i = 0; i < 5; i++) {
      expect(result[i]).not.toHaveProperty('Dining Out__avg');
    }
    expect(result[5]['Dining Out__avg']).toBe(350); // mean(100..600)
  });

  it('computes a correct trailing window per row per group across 5+ rows and 2 groups (explicit window)', () => {
    const rows = [
      { name: '2023-01', A: 10, B: 0 },
      { name: '2023-02', A: 20, B: 10 },
      { name: '2023-03', A: 30, B: 20 },
      { name: '2023-04', A: 60, B: 30 },
      { name: '2023-05', A: 90, B: 40 },
    ];
    const result = computeTrendMovingAverages(rows, ['A', 'B'], 3);
    expect(result[0]).not.toHaveProperty('A__avg');
    expect(result[1]).not.toHaveProperty('A__avg');
    expect(result[2]['A__avg']).toBe(20); // mean(10, 20, 30)
    expect(result[2]['B__avg']).toBe(10); // mean(0, 10, 20)
    expect(result[3]['A__avg']).toBe(110 / 3); // mean(20, 30, 60)
    expect(result[4]['A__avg']).toBe(60); // mean(30, 60, 90)
    expect(result[4]['B__avg']).toBe(30); // mean(20, 30, 40)
  });

  it('includes a 0 value in the window instead of skipping it (explicit window)', () => {
    const rows = [
      { name: '2023-01', 'Dining Out': 300 },
      { name: '2023-02', 'Dining Out': 0 },
      { name: '2023-03', 'Dining Out': 300 },
    ];
    const result = computeTrendMovingAverages(rows, ['Dining Out'], 3);
    expect(result[2]['Dining Out__avg']).toBe(200); // mean(300, 0, 300), not mean(300, 300)
  });
});
