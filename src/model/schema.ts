import type { z } from 'zod';

// The export loader parses field by field (see src/load/loader.ts) so that one odd field never drops a whole
// journey. zod is used for bk.config.json, where a clear error is better than a guess.

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
