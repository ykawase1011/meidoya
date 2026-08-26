import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The CLI's session credential: the secret the daemon provisioned for this
 * ingress profile. It is what `session.hello` proves possession of, so that a
 * client cannot simply assert someone else's workspace coordinates.
 *
 * Looked up, in order:
 *   1. MEIDOYA_CLIENT_SECRET       (the secret itself, for CI and containers)
 *   2. $MEIDOYA_CREDENTIALS_DIR/<profile>.secret
 *   3. $MEIDOYA_DATA_DIR/clients/<profile>.secret
 *   4. <dir of the control socket>/clients/<profile>.secret   (the default)
 */
export function credentialCandidates(
  profile: string | undefined,
  socketPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const name = `${profile ?? "default"}.secret`;
  const files: string[] = [];
  const explicitDir = env["MEIDOYA_CREDENTIALS_DIR"];
  if (explicitDir !== undefined) files.push(path.join(explicitDir, name));
  const dataDir = env["MEIDOYA_DATA_DIR"];
  if (dataDir !== undefined) files.push(path.join(dataDir, "clients", name));
  files.push(path.join(path.dirname(socketPath), "clients", name));
  return files;
}

function readIfPrivate(file: string): string | undefined {
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    return undefined;
  }
  // Same rule as an ssh private key: a credential others can read is not one.
  if ((mode & 0o077) !== 0) {
    throw new Error(`session credential ${file} is group/world accessible; chmod 600 it`);
  }
  const text = readFileSync(file, "utf8").trim();
  return text === "" ? undefined : text;
}

export function readSessionCredential(
  profile: string | undefined,
  socketPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const inline = env["MEIDOYA_CLIENT_SECRET"];
  if (inline !== undefined && inline.trim() !== "") return inline.trim();
  for (const file of credentialCandidates(profile, socketPath, env)) {
    const secret = readIfPrivate(file);
    if (secret !== undefined) return secret;
  }
  return undefined;
}
