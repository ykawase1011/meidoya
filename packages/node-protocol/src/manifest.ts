import { z } from "zod";

export const ReleaseArtifactSchema = z.object({
  platform: z.enum(["darwin", "linux"]),
  arch: z.enum(["arm64", "x64"]),
  sha256: z.string(),
  url: z.string().optional(),
});
export type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>;

/**
 * @meidoya/node-manifest contract: describes a meidoya-node release.
 * meidoya-yashiki pins this and verifies checksums before install.
 */
export const NodeReleaseManifestSchema = z.object({
  product: z.literal("meidoya-node"),
  version: z.string(),
  protocolVersion: z.number().int(),
  artifacts: z.array(ReleaseArtifactSchema),
});
export type NodeReleaseManifest = z.infer<typeof NodeReleaseManifestSchema>;

export const NodeInstallReceiptSchema = z.object({
  product: z.literal("meidoya-node"),
  version: z.string(),
  protocolVersion: z.number().int(),
  artifactSha256: z.string(),
  installedAt: z.string(),
});
export type NodeInstallReceipt = z.infer<typeof NodeInstallReceiptSchema>;
