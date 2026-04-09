/**
 * Typed helpers for mocking TanStack Query hook return values in tests.
 *
 * Replaces the `as any` pattern that previously shimmed mock objects because
 * a full UseQueryResult / UseMutationResult has ~20 properties and tests only
 * care about a few. These helpers build minimal-but-type-correct fakes via
 * a single `as unknown as …` cast at the helper boundary, so test files can
 * stay clean and avoid `@typescript-eslint/no-explicit-any` violations.
 *
 * Usage:
 *   vi.mocked(useAdapters).mockReturnValue(mockQueryResult([{ id: 1 }]));
 *   vi.mocked(useUploadSmartImport).mockReturnValue(mockMutationResult({ mutate: uploadMock }));
 */

import { vi } from 'vitest';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';

/** Fake a successful `useQuery` result with only the fields that matter. */
export function mockQueryResult<T>(
  data: T,
  overrides: Partial<UseQueryResult<T>> = {},
): UseQueryResult<T> {
  return {
    data,
    isLoading: false,
    isError: false,
    isSuccess: data !== undefined && data !== null,
    isFetching: false,
    isPending: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as UseQueryResult<T>;
}

/** Fake a `useQuery` result in the loading state. */
export function mockQueryLoading<T>(
  overrides: Partial<UseQueryResult<T>> = {},
): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    isSuccess: false,
    isFetching: true,
    isPending: true,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as UseQueryResult<T>;
}

/** Fake a `useQuery` result in the error state. */
export function mockQueryError<T>(
  error: Error = new Error('mock error'),
  overrides: Partial<UseQueryResult<T>> = {},
): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    isSuccess: false,
    isFetching: false,
    isPending: false,
    error,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as UseQueryResult<T>;
}

/** Fake a `useMutation` result. Caller supplies `mutate`/`mutateAsync` spies. */
export function mockMutationResult<TData = unknown, TVariables = void>(
  overrides: Partial<UseMutationResult<TData, Error, TVariables>> = {},
): UseMutationResult<TData, Error, TVariables> {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isIdle: true,
    isError: false,
    isSuccess: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    ...overrides,
  } as unknown as UseMutationResult<TData, Error, TVariables>;
}
