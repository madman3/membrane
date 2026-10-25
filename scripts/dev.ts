const processes = ["apps/api", "apps/web"].map((cwd) =>
  Bun.spawn(["bun", "dev"], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
);

async function shutdown(exitCode: number) {
  for (const child of processes) child.kill();
  await Promise.all(processes.map((child) => child.exited));
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

const exitCode = await Promise.race(processes.map((child) => child.exited));
console.error(`A dev process exited (${exitCode}). Stopping the others.`);
await shutdown(typeof exitCode === "number" ? exitCode : 1);
