/** A copy of process.env loses Windows' case-insensitive property access. */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform = process.platform): string | undefined {
  if (Object.hasOwn(env, name)) return env[name];
  if (platform === 'win32') {
    const upper = name.toUpperCase();
    const key = Object.keys(env).find(candidate => candidate.toUpperCase() === upper);
    if (key !== undefined) return env[key];
  }
  return undefined;
}

/** Apply child overrides in order, keeping one spelling of each Windows name. */
export function childEnv(platform: NodeJS.Platform, ...sources: NodeJS.ProcessEnv[]): Record<string, string> {
  const entries = new Map<string, [string, string]>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined) entries.set(platform === 'win32' ? name.toUpperCase() : name, [name, value]);
    }
  }
  return Object.fromEntries(entries.values());
}

/** Replace any inherited spelling before assigning a child-specific value. */
export function setEnvValue(env: Record<string, string>, platform: NodeJS.Platform, name: string, value: string): void {
  if (platform === 'win32') {
    const upper = name.toUpperCase();
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === upper) delete env[key];
    }
  }
  env[name] = value;
}
