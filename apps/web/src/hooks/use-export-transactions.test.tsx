import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useExportTransactions } from './use-export-transactions';
import { api } from '@/lib/api';

// Create a mock for the API method
vi.mock('@/lib/api', () => ({
  api: {
    exportTransactions: vi.fn(),
  }
}));

describe('useExportTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock the DOM APIs used by the export function
    window.URL.createObjectURL = vi.fn(() => 'blob:http://localhost/mock-url');
    window.URL.revokeObjectURL = vi.fn();
  });

  it('handles the export flow successfully', async () => {
    // 1. Setup the mock blob response
    const mockBlob = new Blob(['mock csv data'], { type: 'text/csv' });
    vi.mocked(api.exportTransactions).mockResolvedValueOnce(mockBlob);

    vi.spyOn(document.body, 'appendChild');
    vi.spyOn(document.body, 'removeChild');

    // 3. Render and execute the hook
    const { result } = renderHook(() => useExportTransactions());
    
    expect(result.current.isExporting).toBe(false);

    let exportPromise: Promise<void>;
    act(() => {
      exportPromise = result.current.exportTransactions({ accountId: 10 });
    });

    // It should be exporting immediately after call
    expect(result.current.isExporting).toBe(true);

    // Await completion
    await act(async () => {
      await exportPromise;
    });

    // 4. Verification
    expect(result.current.isExporting).toBe(false);
    expect(api.exportTransactions).toHaveBeenCalledWith({ accountId: 10 });
    expect(window.URL.createObjectURL).toHaveBeenCalledWith(mockBlob);
    
    const today = new Date().toISOString().slice(0, 10);
    
    expect(document.body.appendChild).toHaveBeenCalled();
    const calls = vi.mocked(document.body.appendChild).mock.calls;
    const appendedNode = calls.map(c => c[0] as HTMLElement).find(n => n.tagName === 'A') as HTMLAnchorElement;
    
    expect(appendedNode).toBeDefined();
    expect(appendedNode.tagName).toBe('A');
    expect(appendedNode.download).toBe(`bliss-export-${today}.csv`);
    expect(appendedNode.href).toContain('blob:http://localhost/mock-url');
    
    expect(document.body.removeChild).toHaveBeenCalledWith(appendedNode);
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/mock-url');
  });

  it('resets isExporting flag even if API call fails', async () => {
    vi.mocked(api.exportTransactions).mockRejectedValueOnce(new Error('Export failed'));

    const { result } = renderHook(() => useExportTransactions());
    
    await act(async () => {
      // Must catch the error mapping since it's an unhandled promise rejection in the test otherwise
      try {
        await result.current.exportTransactions();
      } catch (e) {
        // expected
      }
    });

    expect(result.current.isExporting).toBe(false);
  });
});
