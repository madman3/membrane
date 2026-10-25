import Link from "next/link";

import {
  phoenixExperimentUrl,
  readImpactResult,
  type Verdict,
} from "../../lib/impact-data";

export const dynamic = "force-dynamic";

function formatRunDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function verdictClass(verdict: Verdict): string {
  return `impact-verdict impact-verdict-${verdict.toLowerCase()}`;
}

function agentSummary(counts: {
  pass: number;
  fail: number;
  neutral: number;
  inconclusive: number;
  insufficient: number;
}): string {
  const total =
    counts.pass + counts.fail + counts.neutral + counts.inconclusive + counts.insufficient;
  const breakdown = `${total} ${total === 1 ? "case" : "cases"}: ${counts.pass} pass, ${counts.fail} fail, ${counts.neutral} neutral, ${counts.inconclusive} inconclusive, ${counts.insufficient} insufficient.`;
  if (counts.insufficient === 0) return breakdown;

  return `${breakdown} Evidence improved but was not reliable in ${counts.insufficient} ${
    counts.insufficient === 1 ? "case" : "cases"
  }.`;
}

function EmptyImpact() {
  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">Forte Partners</p>
          <h1>Memory impact</h1>
        </div>
        <Link className="button" href="/">
          Back to candidates
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

export default async function ImpactPage() {
  const result = await readImpactResult();
  if (!result) return <EmptyImpact />;

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
          <p className="eyebrow">Evaluation result</p>
          <h1>Memory impact</h1>
          <p className="subtitle">Control and treatment outcomes from the latest run.</p>
        </div>
        <Link className="button" href="/">
          Back to candidates
        </Link>
      </header>

      <div className="impact-page">
        <section className="impact-overview" aria-labelledby="impact-heading">
          <div className="impact-section-head">
            <div>
              <p className="eyebrow">Latest run</p>
              <h2 id="impact-heading">Impact by agent</h2>
            </div>
            <div className="impact-links">
              <a href={controlUrl} target="_blank" rel="noopener noreferrer">
                Control in Phoenix
              </a>
              <a href={treatmentUrl} target="_blank" rel="noopener noreferrer">
                Treatment in Phoenix
              </a>
            </div>
          </div>

          <div className="impact-agent-grid">
            {Object.entries(result.byAgent).map(([agent, counts]) => (
              <article className="impact-agent-card" key={agent}>
                <h3>{agent}</h3>
                <div className="impact-counts">
                  <span className="impact-count-pass">
                    <strong>{counts.pass}</strong>
                    PASS
                  </span>
                  <span className="impact-count-fail">
                    <strong>{counts.fail}</strong>
                    FAIL
                  </span>
                  <span className="impact-count-neutral">
                    <strong>{counts.neutral}</strong>
                    NEUTRAL
                  </span>
                  <span className="impact-count-inconclusive">
                    <strong>{counts.inconclusive}</strong>
                    INCONCLUSIVE
                  </span>
                  <span className="impact-count-insufficient">
                    <strong>{counts.insufficient}</strong>
                    INSUFFICIENT
                  </span>
                </div>
                <p>{agentSummary(counts)}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="impact-metadata" aria-labelledby="run-details-heading">
          <div>
            <h2 id="run-details-heading">Run details</h2>
            <dl className="impact-meta-grid">
              <div>
                <dt>Model</dt>
                <dd>{result.model}</dd>
              </div>
              <div>
                <dt>Effort</dt>
                <dd>{result.effort}</dd>
              </div>
              <div>
                <dt>Run date</dt>
                <dd>{formatRunDate(result.runAt)}</dd>
              </div>
              <div>
                <dt>Repetitions</dt>
                <dd>{result.repetitions}</dd>
              </div>
            </dl>
          </div>
          <div>
            <h2>Memory</h2>
            <p className="impact-memory">{result.memory}</p>
          </div>
        </section>

        <section className="impact-cases" aria-labelledby="cases-heading">
          <div className="impact-section-head">
            <h2 id="cases-heading">Cases</h2>
            <span className="count">{result.cases.length} total</span>
          </div>
          <div className="impact-table-wrap">
            <table className="impact-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Ticket</th>
                  <th>Type</th>
                  <th>Passes</th>
                  <th>Verdict</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {result.cases.map((item) => {
                  const href = `/impact/${encodeURIComponent(item.id)}`;
                  return (
                    <tr key={item.id}>
                      <td>
                        <Link className="impact-cell-link impact-case-link mono" href={href}>
                          {item.id}
                        </Link>
                      </td>
                      <td>
                        <Link className="impact-cell-link impact-ticket-link" href={href}>
                          <strong>{item.ticketSubject}</strong>
                          <span>{item.ticketId}</span>
                        </Link>
                      </td>
                      <td>
                        <Link className="impact-cell-link" href={href}>
                          {item.caseType}
                        </Link>
                      </td>
                      <td className="impact-nowrap">
                        <Link className="impact-cell-link" href={href}>
                          control {item.controlPasses}/5 → treatment {item.treatmentPasses}/5
                        </Link>
                      </td>
                      <td>
                        <Link className="impact-cell-link" href={href}>
                          <span className={verdictClass(item.verdict)}>{item.verdict}</span>
                        </Link>
                      </td>
                      <td>
                        <Link className="impact-cell-link" href={href}>
                          {item.verdictReason}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
