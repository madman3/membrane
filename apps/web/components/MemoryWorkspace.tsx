"use client";

import type { CreateMemoryInput, MemoryCandidate, MemoryCandidateDetail } from "@memeval/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "../lib/api";
import { formatDate, statusLabel } from "../lib/format";
import { CandidateDetail } from "./CandidateDetail";
import { CreateCandidateForm } from "./CreateCandidateForm";

type MemoryWorkspaceProps = {
  apiUrl: string;
};

export function MemoryWorkspace({ apiUrl }: MemoryWorkspaceProps) {
  const client = useMemo(() => createClient(apiUrl), [apiUrl]);
  const [candidates, setCandidates] = useState<MemoryCandidate[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryCandidateDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const closeForm = useCallback(() => setCreating(false), []);

  const loadList = useCallback(
    async (preferId?: string) => {
      setListError(null);
      try {
        const next = await client.listMemories();
        setCandidates(next);
        setSelectedId((current) => {
          const preferred = preferId ?? current;
          if (preferred && next.some((candidate) => candidate.id === preferred)) return preferred;
          return next[0]?.id ?? null;
        });
      } catch (error) {
        setListError(error instanceof Error ? error.message : "Could not load memory candidates.");
      }
    },
    [client],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    client
      .getMemory(selectedId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetailError(error instanceof Error ? error.message : "Could not load the candidate.");
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, selectedId]);

  async function handleCreate(input: CreateMemoryInput) {
    const created = await client.createMemory(input);
    await loadList(created.id);
  }

  async function handleAddVersion(content: string) {
    if (!selectedId) return;
    await client.addVersion(selectedId, content);
    const next = await client.getMemory(selectedId);
    setDetail(next);
    await loadList(selectedId);
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">Forte Partners</p>
          <h1>Memory Evaluation</h1>
          <p className="subtitle">Candidates and versions for proposed memory changes.</p>
        </div>
        <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
          New candidate
        </button>
      </header>

      {candidates === null && listError ? (
        <section className="status-card">
          <h2>Could not load candidates</h2>
          <p>{listError}</p>
          <button type="button" className="button" onClick={() => void loadList()}>
            Retry
          </button>
        </section>
      ) : null}

      {candidates === null && !listError ? (
        <section className="status-card">
          <h2>Loading memory candidates…</h2>
        </section>
      ) : null}

      {candidates && candidates.length === 0 ? (
        <section className="empty">
          <h2>No memory candidates yet</h2>
          <p>Create one when you have a proposed memory change to store. This page does not score or promote it.</p>
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            New candidate
          </button>
        </section>
      ) : null}

      {candidates && candidates.length > 0 ? (
        <section className="workspace">
          <div className="panel">
            <div className="panel-head">
              <h2>Candidates</h2>
              <span className="count">
                {candidates.length} {candidates.length === 1 ? "record" : "records"}
              </span>
            </div>
            {listError ? <p className="banner">{listError}</p> : null}
            <div className="candidate-list">
              {candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className={candidate.id === selectedId ? "candidate is-selected" : "candidate"}
                  aria-pressed={candidate.id === selectedId}
                  onClick={() => setSelectedId(candidate.id)}
                >
                  <span className="candidate-title">{candidate.title}</span>
                  <span className="candidate-meta">
                    <span className="type-label">{candidate.memoryType}</span>
                    <span className={`badge badge-${candidate.status}`}>{statusLabel(candidate.status)}</span>
                  </span>
                  <span className="meta">{formatDate(candidate.createdAt)}</span>
                </button>
              ))}
            </div>
          </div>

          {detailLoading ? (
            <section className="detail">
              <p className="section">Loading candidate…</p>
            </section>
          ) : null}
          {detailError ? (
            <section className="detail">
              <p className="banner">{detailError}</p>
            </section>
          ) : null}
          {detail ? <CandidateDetail candidate={detail} onAddVersion={handleAddVersion} /> : null}
        </section>
      ) : null}

      <CreateCandidateForm open={creating} onClose={closeForm} onCreate={handleCreate} />
    </main>
  );
}
