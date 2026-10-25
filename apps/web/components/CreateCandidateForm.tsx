"use client";

import { createMemorySchema, type CreateMemoryInput, type MemoryStatus } from "@memeval/contracts";
import { useEffect, useId, useState, type FormEvent } from "react";
import { parseIdList, statusLabel } from "../lib/format";

const statuses: MemoryStatus[] = ["draft", "ready", "evaluating", "evaluated"];

type CreateCandidateFormProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateMemoryInput) => Promise<void>;
};

function fieldMessages(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const messages: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join(".");
    if (path && !messages[path]) messages[path] = issue.message;
  }
  return messages;
}

export function CreateCandidateForm({ open, onClose, onCreate }: CreateCandidateFormProps) {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [memoryType, setMemoryType] = useState("");
  const [status, setStatus] = useState<MemoryStatus>("draft");
  const [agentIds, setAgentIds] = useState("");
  const [customerIds, setCustomerIds] = useState("");
  const [taskTypes, setTaskTypes] = useState("");
  const [sourceSystem, setSourceSystem] = useState("");
  const [sourceRecordId, setSourceRecordId] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    let observedAtIso: string | undefined;
    if (observedAt) {
      const parsedDate = new Date(observedAt);
      if (Number.isNaN(parsedDate.getTime())) {
        setErrors({ "provenance.observedAt": "Enter a valid date and time." });
        return;
      }
      observedAtIso = parsedDate.toISOString();
    }

    const scope = {
      ...(parseIdList(agentIds).length ? { agentIds: parseIdList(agentIds) } : {}),
      ...(parseIdList(customerIds).length ? { customerIds: parseIdList(customerIds) } : {}),
      ...(parseIdList(taskTypes).length ? { taskTypes: parseIdList(taskTypes) } : {}),
    };

    const parsed = createMemorySchema.safeParse({
      title,
      content,
      memoryType,
      status,
      scope,
      provenance: {
        sourceSystem,
        sourceRecordId,
        ...(observedAtIso ? { observedAt: observedAtIso } : {}),
        ...(description.trim() ? { description } : {}),
      },
    });

    if (!parsed.success) {
      setErrors(fieldMessages(parsed.error.issues));
      return;
    }

    setSaving(true);
    try {
      await onCreate(parsed.data);
      setTitle("");
      setContent("");
      setMemoryType("");
      setStatus("draft");
      setAgentIds("");
      setCustomerIds("");
      setTaskTypes("");
      setSourceSystem("");
      setSourceRecordId("");
      setObservedAt("");
      setDescription("");
      setErrors({});
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not create the candidate.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>New memory candidate</h2>
        <p className="dialog-intro">
          Record the proposed memory, where it applies, and where it came from. Evaluation is not run from this form.
        </p>
        <form className="create-form" onSubmit={handleSubmit} noValidate>
          {formError ? (
            <p className="banner" role="alert">
              {formError}
            </p>
          ) : null}
          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus maxLength={200} />
            {errors.title ? <small className="field-error">{errors.title}</small> : null}
          </label>
          <label className="field">
            <span>Content</span>
            <textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={20000} />
            {errors.content ? <small className="field-error">{errors.content}</small> : null}
          </label>
          <div className="grid-2">
            <label className="field">
              <span>Memory type</span>
              <input
                value={memoryType}
                onChange={(event) => setMemoryType(event.target.value)}
                placeholder="For example, fact or instruction"
                maxLength={80}
              />
              {errors.memoryType ? <small className="field-error">{errors.memoryType}</small> : null}
            </label>
            <label className="field">
              <span>Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as MemoryStatus)}>
                {statuses.map((item) => (
                  <option key={item} value={item}>
                    {statusLabel(item)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset>
            <legend>Scope</legend>
            <p className="hint">Optional. Separate multiple ids with commas.</p>
            <div className="grid-3">
              <label className="field">
                <span>Agent ids</span>
                <input value={agentIds} onChange={(event) => setAgentIds(event.target.value)} />
              </label>
              <label className="field">
                <span>Customer ids</span>
                <input value={customerIds} onChange={(event) => setCustomerIds(event.target.value)} />
              </label>
              <label className="field">
                <span>Task types</span>
                <input value={taskTypes} onChange={(event) => setTaskTypes(event.target.value)} />
              </label>
            </div>
          </fieldset>
          <fieldset>
            <legend>Provenance</legend>
            <div className="grid-2">
              <label className="field">
                <span>Source system</span>
                <input value={sourceSystem} onChange={(event) => setSourceSystem(event.target.value)} maxLength={200} />
                {errors["provenance.sourceSystem"] ? (
                  <small className="field-error">{errors["provenance.sourceSystem"]}</small>
                ) : null}
              </label>
              <label className="field">
                <span>Source record id</span>
                <input
                  value={sourceRecordId}
                  onChange={(event) => setSourceRecordId(event.target.value)}
                  maxLength={200}
                />
                {errors["provenance.sourceRecordId"] ? (
                  <small className="field-error">{errors["provenance.sourceRecordId"]}</small>
                ) : null}
              </label>
            </div>
            <label className="field">
              <span>Observed at</span>
              <input type="datetime-local" value={observedAt} onChange={(event) => setObservedAt(event.target.value)} />
              {errors["provenance.observedAt"] ? (
                <small className="field-error">{errors["provenance.observedAt"]}</small>
              ) : null}
            </label>
            <label className="field">
              <span>Description</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} />
            </label>
          </fieldset>
          <div className="actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? "Saving…" : "Create candidate"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
