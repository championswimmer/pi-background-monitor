export const MAX_MONITORS = 64;
export type Limits = { maxOpen: number; maxTotal: number };
export const DEFAULT_LIMITS: Limits = { maxOpen: 8, maxTotal: 16 };
export function validLimits(value: unknown): value is Limits {
  const v = value as Limits | null;
  return (
    !!v && [v.maxOpen, v.maxTotal].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_MONITORS)
  );
}
