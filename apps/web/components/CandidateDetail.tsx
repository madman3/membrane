"use client";

import type { MemoryCandidateDetail } from "@memeval/contracts";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { formatDate, statusLabel } from "../lib/format";

type CandidateDetailProps = {
  candidate: MemoryCandidateDetail;
  onAddVersion: (content: string) => Promise<void>;
};

function ScopeList({ label, values }: { label: string; values: string[] | undefined }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{values && values.length > 0 ? values.join(", ") : "None"}</dd>
    </>
  );
}

export function CandidateDetail({ candidate, onAddVersion }: CandidateDetailProps) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(candidate.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  async function handleVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = content.trim();
    if (!next) {
      setError("Enter the new content.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onAddVersion(next);
      setContent("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the version.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="detail">
      <header className="detail-head">
        <div>
          <h2>{candidate.title}</h2>
          <div className="detail-meta">
            <span className={`badge badge-${candidate.status}`}>{statusLabel(candidate.status)}</span>
            <span className="type-label">{candidate.memoryType}</span>
            <span className="meta">Created {formatDate(candidate.createdAt)}</span>
          </div>
          <div className="record-row">
            <code className="record-id">{candidate.id}</code>
            <button type="button" className="link-button" onClick={() => void copyId()}>
              {copied ? "Copied" : "Copy id"}
            </button>
            <Link className="link-button" href="/impact">
              View memory impact
            </Link>
          </div>
        </div>
      </header>

      <section className="section">
        <h3>Content</h3>
        <p className="prose">{candidate.content}</p>
        <p className="hint">Updated {formatDate(candidate.updatedAt)}</p>
      </section>

      <section className="section">
        <h3>Scope</h3>
        <dl className="kv">
          <ScopeList label="Agents" values={candidate.scope.agentIds} />
          <ScopeList label="Customers" values={candidate.scope.customerIds} />
          <ScopeList label="Task types" values={candidate.scope.taskTypes} />
        </dl>
      </section>

      <section className="section">
        <h3>Provenance</h3>
        <dl className="kv">
          <dt>Source system</dt>
          <dd>{candidate.provenance.sourceSystem}</dd>
          <dt>Source record</dt>
          <dd>{candidate.provenance.sourceRecordId}</dd>
          <dt>Observed</dt>
          <dd>{candidate.provenance.observedAt ? formatDate(candidate.provenance.observedAt) : "Not recorded"}</dd>
          <dt>Description</dt>
          <dd>{candidate.provenance.description ?? "None"}</dd>
        </dl>
      </section>

      <section className="section">
        <h3>Versions</h3>
        <div className="version-list">
          {candidate.versions.map((version, index) => (
            <details key={version.id} className="version" open={index === candidate.versions.length - 1}>
              <summary>
                Version {version.version} · {formatDate(version.createdAt)}
              </summary>
              <p>{version.content}</p>
            </details>
          ))}
        </div>
        <form className="version-form" onSubmit={(event) => void handleVersion(event)}>
          <label className="field">
            <span>New version</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="This becomes the candidate's current content."
              maxLength={20000}
            />
          </label>
          {error ? <p className="field-error">{error}</p> : null}
          <div className="actions">
            <button type="submit" className="button" disabled={saving}>
              {saving ? "Saving…" : "Save version"}
            </button>
          </div>
        </form>
      </section>
    </article>
  );
}
