import Link from "next/link";
import { notFound } from "next/navigation";

import {
  phoenixExperimentUrl,
  readImpactResult,
  type Decision,
  type DecisionField,
  type DecisionValue,
  type Verdict,
} from "../../../lib/impact-data";

export const dynamic = "force-dynamic";

type CaseDetailPageProps = {
  params: Promise<{ caseId: string }>;
};

type DistributionEntry = {
  key: string;
  value: DecisionValue;
  count: number;
};

function canonicalValueKey(value: DecisionValue): string {
  if (value === null) return "null:";
  return `${typeof value}:${JSON.stringify(value)}`;
}

function displayValue(value: DecisionValue): string {
  return value === null ? "null" : String(value);
}

function distribution(decisions: Decision[], field: DecisionField): DistributionEntry[] {
  const counts = new Map<string, DistributionEntry>();

  for (const decision of decisions) {
    const value = decision[field];
    const key = canonicalValueKey(value);
    const current = counts.get(key);
    counts.set(key, current ? { ...current, count: current.count + 1 } : { key, value, count: 1 });
  }

  // Deterministic presentation: most frequent first, then readable value and
  // finally the typed canonical key (so null, "null", 1, and "1" stay distinct).
  return [...counts.values()].sort(
    (left, right) =>
      right.count - left.count ||
      displayValue(left.value).localeCompare(displayValue(right.value)) ||
      left.key.localeCompare(right.key),
  );
}

function distributionsMatch(
  control: DistributionEntry[],
  treatment: DistributionEntry[],
): boolean {
  if (control.length !== treatment.length) return false;
  const treatmentCounts = new Map(treatment.map(({ key, count }) => [key, count]));
  return control.every(({ key, count }) => treatmentCounts.get(key) === count);
}

function verdictClass(verdict: Verdict): string {
  return `impact-verdict impact-verdict-${verdict.toLowerCase()}`;
}

function DistributionList({ entries }: { entries: DistributionEntry[] }) {
  return (
    <ul className="impact-distribution">
      {entries.map(({ key, value, count }) => (
        <li key={key}>
          <span className={value === null ? "mono" : undefined}>{displayValue(value)}</span>
          <span aria-label={`${count} occurrences`}> ×{count}</span>
        </li>
      ))}
    </ul>
  );
}

function DecisionComparison({
  control,
  treatment,
  fields,
}: {
  control: Decision[];
  treatment: Decision[];
  fields: DecisionField[];
}) {
  return fields.map((field) => {
    const controlDistribution = distribution(control, field);
    const treatmentDistribution = distribution(treatment, field);
    const differs = !distributionsMatch(controlDistribution, treatmentDistribution);

    return (
      <tr key={field}>
        <th scope="row">{field}</th>
        <td className={differs ? "impact-difference" : undefined}>
          <DistributionList entries={controlDistribution} />
        </td>
        <td className={differs ? "impact-difference" : undefined}>
          <DistributionList entries={treatmentDistribution} />
        </td>
      </tr>
    );
  });
}

export default async function CaseDetailPage({ params }: CaseDetailPageProps) {
  const result = await readImpactResult();
  if (!result) {
    return (
      <main className="app">
        <header className="topbar">
          <div>
            <p className="eyebrow">Evaluation result</p>
            <h1>Case detail</h1>
          </div>
          <Link className="button" href="/impact">
            Back to impact
          </Link>
        </header>
        <section className="status-card">
          <h2>No evaluation run yet</h2>
          <p>
            Run <code className="mono">bun run eval:run</code> to generate the latest evaluation result.
          </p>
        </section>
      </main>
    );
  }

  const { caseId } = await params;
  const item = result.cases.find((candidate) => candidate.id === caseId);
  if (!item) notFound();

  const controlUrl = phoenixExperimentUrl(
    result.phoenix.datasetId,
    result.phoenix.controlExperimentId,
  );
  const treatmentUrl = phoenixExperimentUrl(
    result.phoenix.datasetId,
    result.phoenix.treatmentExperimentId,
  );

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">
            {item.agent} · {item.caseType}
          </p>
          <h1>{item.ticketSubject}</h1>
          <p className="subtitle">
            Ticket {item.ticketId} · Case <span className="mono">{item.id}</span>
          </p>
        </div>
        <Link className="button" href="/impact">
          Back to impact
        </Link>
      </header>

      <div className="impact-page impact-detail-page">
        <section className="impact-case-summary">
          <div>
            <span className={verdictClass(item.verdict)}>{item.verdict}</span>
            <p>{item.verdictReason}</p>
          </div>
          <p className="impact-score">
            Control {item.controlPasses}/5 <span aria-hidden="true">→</span> Treatment{" "}
            {item.treatmentPasses}/5
          </p>
        </section>

        <section className="impact-ticket">
          <h2>Ticket description</h2>
          <p>{item.ticketDescription}</p>
        </section>

        <section className="impact-expected">
          <h2>Expected graded values</h2>
          <dl className="impact-expected-grid">
            {item.gradedFields.map((field) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>
                  {item.expected[field] === null
                    ? "null"
                    : (item.expected[field] ?? "Not specified")}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="impact-comparisons" aria-labelledby="comparison-heading">
          <div className="impact-section-head">
            <h2 id="comparison-heading">Control vs treatment distributions</h2>
            <div className="impact-links">
              <a href={controlUrl} target="_blank" rel="noopener noreferrer">
                Control in Phoenix
              </a>
              <a href={treatmentUrl} target="_blank" rel="noopener noreferrer">
                Treatment in Phoenix
              </a>
            </div>
          </div>

          <div className="impact-table-wrap">
            <table className="impact-comparison-table">
              <thead>
                <tr>
                  <th>Graded field</th>
                  <th>Control</th>
                  <th>Treatment</th>
                </tr>
              </thead>
              <tbody>
                <DecisionComparison
                  control={item.controlDecisions}
                  treatment={item.treatmentDecisions}
                  fields={item.gradedFields}
                />
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
