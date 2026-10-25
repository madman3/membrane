import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { deriveDatasetName, loadDecisionExamples } from "../src/cases";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("deriveDatasetName", () => {
  test("is stable across case enumeration order", () => {
    const first = deriveDatasetName("/tmp/eval cases.csv", "csv", ["case-c", "case-a", "case-b"]);
    const second = deriveDatasetName("/other/eval cases.csv", "csv", [
      "case-b",
      "case-c",
      "case-a",
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^memory-eval-eval-cases-[0-9a-f]{12}$/);
  });

  test("changes with the case ID set or source basename", () => {
    const original = deriveDatasetName("/tmp/alpha.csv", "csv", ["case-a", "case-b"]);

    expect(deriveDatasetName("/tmp/alpha.csv", "csv", ["case-a", "case-c"])).not.toBe(original);
    expect(deriveDatasetName("/tmp/alpha.csv", "csv", ["case-a", "case-b", "case-c"])).not.toBe(
      original,
    );
    expect(deriveDatasetName("/tmp/beta.csv", "csv", ["case-a", "case-b"])).not.toBe(original);
  });

  test("sanitizes CSV and directory source basenames safely", () => {
    expect(deriveDatasetName("/tmp/Customer Cases.CSV", "csv", ["case-a"])).toMatch(
      /^memory-eval-customer-cases-[0-9a-f]{12}$/,
    );
    expect(deriveDatasetName("/tmp/%%% Odd___Name !!!.csv", "csv", ["case-a"])).toMatch(
      /^memory-eval-odd-name-[0-9a-f]{12}$/,
    );
    expect(deriveDatasetName("/tmp/%%%.csv", "csv", ["case-a"])).toMatch(
      /^memory-eval-cases-[0-9a-f]{12}$/,
    );
    expect(deriveDatasetName("/tmp/Folder.CSV", "directory", ["case-a"])).toMatch(
      /^memory-eval-folder-csv-[0-9a-f]{12}$/,
    );
  });
});

describe("loadDecisionExamples JSON case counts", () => {
  test.each([1, 3, 5])("accepts %i valid cases", async (count) => {
    const directory = await createCaseDirectory(count);
    const loaded = await loadDecisionExamples(directory);

    expect(loaded.examples).toHaveLength(count);
    expect(loaded.sourcePath).toBe(directory);
    expect(loaded.sourceType).toBe("directory");
  });

  test("rejects a JSON directory with zero cases", async () => {
    const directory = await createCaseDirectory(0);

    await expect(loadDecisionExamples(directory)).rejects.toThrow("must contain at least one case");
  });
});

async function createCaseDirectory(count: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "memeval-cases-"));
  temporaryDirectories.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "memory.txt"), "Test memory.");
  const cases = Array.from({ length: count }, (_, index) => ({
    id: `variable-count-${index + 1}`,
    agent: "support",
    ticket_id: 4000089,
    case_type: "HELP",
    expected: {
      decision: "escalate",
      linked_issue: null,
      symptom_class: "server_error",
      severity: "high",
    },
    graded_fields: ["decision", "linked_issue", "symptom_class", "severity"],
  }));
  await writeFile(path.join(root, "cases.json"), JSON.stringify(cases));
  return root;
}
