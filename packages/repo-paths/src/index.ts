import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PathSource = string | URL;

export type ResolveExistingPathOptions = {
  from: PathSource;
  packageCwd?: string;
  label?: string;
};

function sourcePath(source: PathSource): string {
  if (source instanceof URL) {
    if (source.protocol !== "file:") {
      throw new Error(`Repository root discovery requires a file URL, received ${source.href}.`);
    }
    return fileURLToPath(source);
  }
  if (source.startsWith("file:")) return fileURLToPath(new URL(source));
  return path.resolve(source);
}

function startingDirectory(source: PathSource): string {
  const resolvedSource = sourcePath(source);
  try {
    if (statSync(resolvedSource).isDirectory()) return resolvedSource;
  } catch {
    // import.meta.url normally identifies a file. A missing source is treated
    // the same way so discovery still terminates with a useful error.
  }
  return path.dirname(resolvedSource);
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

export function findRepositoryRoot(from: PathSource): string {
  const start = startingDirectory(from);
  let directory = start;

  while (true) {
    if (isDirectory(path.join(directory, "packages/evals"))) return directory;

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(
        `Could not find the repository root from ${start}; expected a parent directory containing packages/evals.`,
      );
    }
    directory = parent;
  }
}

export function resolveExistingPath(
  input: string,
  options: ResolveExistingPathOptions,
): string {
  const label = options.label ?? "Path";
  if (path.isAbsolute(input)) {
    const absolutePath = path.resolve(input);
    if (existsSync(absolutePath)) return absolutePath;
    throw new Error(`${label} does not exist: ${absolutePath}.`);
  }

  const repositoryRoot = findRepositoryRoot(options.from);
  const packageCwd = path.resolve(options.packageCwd ?? process.cwd());
  const repositoryPath = path.resolve(repositoryRoot, input);
  const packageCwdPath = path.resolve(packageCwd, input);

  if (existsSync(repositoryPath)) return repositoryPath;
  if (existsSync(packageCwdPath)) return packageCwdPath;

  throw new Error(
    `${label} does not exist. Tried these two resolution bases:\n` +
      `- Repository root: ${repositoryPath}\n` +
      `- Package cwd: ${packageCwdPath}`,
  );
}
