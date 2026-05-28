/**
 * Unit tests for half-open overlap semantics, isolated from the DB.
 *
 * The DB enforces the same semantics through tstzrange && — these tests
 * encode the spec rule so it can't drift unnoticed.
 */
import { describe, expect, it } from 'vitest';

function overlapsHalfOpen(a: [Date, Date], b: [Date, Date]): boolean {
  // [start, end) ∩ [start, end) ≠ ∅  ⇔  a.start < b.end AND b.start < a.end
  return a[0].getTime() < b[1].getTime() && b[0].getTime() < a[1].getTime();
}

const t = (iso: string) => new Date(iso);

describe('half-open overlap semantics', () => {
  it('does NOT consider touching endpoints as overlap (the spec example)', () => {
    const a = [t('2026-05-18T10:00:00Z'), t('2026-05-18T11:00:00Z')] as [Date, Date];
    const b = [t('2026-05-18T11:00:00Z'), t('2026-05-18T12:00:00Z')] as [Date, Date];
    expect(overlapsHalfOpen(a, b)).toBe(false);
  });

  it('detects overlap when intervals share interior time', () => {
    const a = [t('2026-05-18T10:00:00Z'), t('2026-05-18T11:30:00Z')] as [Date, Date];
    const b = [t('2026-05-18T11:00:00Z'), t('2026-05-18T12:00:00Z')] as [Date, Date];
    expect(overlapsHalfOpen(a, b)).toBe(true);
  });

  it('handles containment', () => {
    const outer = [t('2026-05-18T10:00:00Z'), t('2026-05-18T14:00:00Z')] as [Date, Date];
    const inner = [t('2026-05-18T11:00:00Z'), t('2026-05-18T12:00:00Z')] as [Date, Date];
    expect(overlapsHalfOpen(outer, inner)).toBe(true);
    expect(overlapsHalfOpen(inner, outer)).toBe(true);
  });

  it('handles cross-midnight sessions', () => {
    const a = [t('2026-05-18T23:00:00Z'), t('2026-05-19T01:00:00Z')] as [Date, Date];
    const b = [t('2026-05-19T00:30:00Z'), t('2026-05-19T01:00:00Z')] as [Date, Date];
    expect(overlapsHalfOpen(a, b)).toBe(true);
  });

  it('returns false for fully-disjoint ranges', () => {
    const a = [t('2026-05-18T10:00:00Z'), t('2026-05-18T11:00:00Z')] as [Date, Date];
    const b = [t('2026-05-18T12:00:00Z'), t('2026-05-18T13:00:00Z')] as [Date, Date];
    expect(overlapsHalfOpen(a, b)).toBe(false);
  });
});
