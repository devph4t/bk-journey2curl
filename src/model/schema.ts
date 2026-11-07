import { z } from 'zod';

// Loose schemas: they check the parts the loader relies on and let everything else through.
// A failed check becomes a warning, never a crash.

export const treeNodeSchema = z.looseObject({
  nodeType: z.string(),
  displayName: z.string().optional(),
  connections: z.record(z.string(), z.string()).default({}),
  x: z.number().optional(),
  y: z.number().optional(),
});

export const treeSchema = z.looseObject({
  _id: z.string().optional(),
  entryNodeId: z.string(),
  description: z.string().optional(),
  innerTreeOnly: z.boolean().optional(),
  nodes: z.record(z.string(), treeNodeSchema).default({}),
  staticNodes: z.record(z.string(), z.looseObject({ x: z.number(), y: z.number() })).optional(),
});

export const scriptSchema = z.looseObject({
  _id: z.string().optional(),
  name: z.string().optional(),
  script: z.unknown(),
  language: z.string().optional(),
  context: z.string().optional(),
  evaluatorVersion: z.string().optional(),
});

export const bundleSchema = z.looseObject({
  tree: treeSchema,
  nodes: z.record(z.string(), z.looseObject({})).default({}),
  innerNodes: z.record(z.string(), z.looseObject({})).optional(),
  innernodes: z.record(z.string(), z.looseObject({})).optional(),
  scripts: z.record(z.string(), scriptSchema).optional(),
});

export type TreeNodeRaw = z.infer<typeof treeNodeSchema>;
export type TreeRaw = z.infer<typeof treeSchema>;
export type BundleRaw = z.infer<typeof bundleSchema>;
export type ScriptRaw = z.infer<typeof scriptSchema>;

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
