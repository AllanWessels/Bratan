import { useEffect, useMemo, useRef, useState } from "react";
import { Save, X } from "lucide-react";
import { Card } from "@/components/Card";
import { Field, Select, TextArea } from "@/components/Field";
import { Button } from "@/components/Button";
import { useSaveDraft, useSeedSave, useSeedValidate } from "@/api/hooks";
import { useUIStore } from "@/store/uiStore";
import {
  FAILURE_CATEGORIES,
  type FailureCategory,
  type Passage,
  type PassageRef,
} from "@/api/types";
import { useDebounce } from "@/lib/useDebounce";
import { prettyFailureCategory } from "@/lib/format";
import { PassagePicker } from "./PassagePicker";
import { ValidationPanel } from "./ValidationPanel";

interface DraftLocal {
  id: string;
  question: string;
  ground_truth: string;
  passages: PassageRef[];
  failure_category: FailureCategory | "";
  notes: string;
}

function newDraft(): DraftLocal {
  return {
    id: crypto.randomUUID(),
    question: "",
    ground_truth: "",
    passages: [],
    failure_category: "",
    notes: "",
  };
}

function sameRef(a: PassageRef, b: PassageRef): boolean {
  return a.path === b.path && a.line_start === b.line_start && a.line_end === b.line_end;
}

const AUTOSAVE_INTERVAL_MS = 2000;
const VALIDATE_DEBOUNCE_MS = 600;

export function CaseWizard() {
  const [draft, setDraft] = useState<DraftLocal>(() => newDraft());
  const [runPipeline, setRunPipeline] = useState(false);
  const pushToast = useUIStore((s) => s.pushToast);

  const saveDraft = useSaveDraft();
  const seedSave = useSeedSave();
  const validate = useSeedValidate();

  // Auto-save draft every 2s while editing
  const lastSerializedRef = useRef<string>("");
  useEffect(() => {
    const interval = setInterval(() => {
      const serialized = JSON.stringify({
        question: draft.question,
        ground_truth: draft.ground_truth,
        passages: draft.passages,
        failure_category: draft.failure_category || null,
        notes: draft.notes,
      });
      const hasContent =
        draft.question.trim() ||
        draft.ground_truth.trim() ||
        draft.passages.length > 0;
      if (hasContent && serialized !== lastSerializedRef.current) {
        lastSerializedRef.current = serialized;
        saveDraft.mutate({
          id: draft.id,
          draft: {
            question: draft.question,
            ground_truth: draft.ground_truth,
            passages: draft.passages,
            failure_category:
              draft.failure_category === "" ? null : draft.failure_category,
            notes: draft.notes,
          },
        });
      }
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [draft, saveDraft]);

  // Debounced validation when key fields change
  const debouncedDraft = useDebounce(
    {
      question: draft.question,
      ground_truth: draft.ground_truth,
      passages: draft.passages,
      runPipeline,
    },
    VALIDATE_DEBOUNCE_MS,
  );

  useEffect(() => {
    if (
      debouncedDraft.question.trim().length >= 3 &&
      debouncedDraft.ground_truth.trim().length >= 1 &&
      debouncedDraft.passages.length > 0
    ) {
      validate.mutate({
        question: debouncedDraft.question,
        ground_truth: debouncedDraft.ground_truth,
        passages: debouncedDraft.passages,
        run_pipeline: debouncedDraft.runPipeline,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debouncedDraft.question,
    debouncedDraft.ground_truth,
    JSON.stringify(debouncedDraft.passages),
    debouncedDraft.runPipeline,
  ]);

  const onAddPassage = (p: Passage) => {
    setDraft((d) =>
      d.passages.some((s) => sameRef(s, p))
        ? d
        : {
            ...d,
            passages: [
              ...d.passages,
              { path: p.path, line_start: p.line_start, line_end: p.line_end },
            ],
          },
    );
  };
  const onRemovePassage = (p: PassageRef) =>
    setDraft((d) => ({ ...d, passages: d.passages.filter((s) => !sameRef(s, p)) }));

  const canSave = useMemo(() => {
    if (!validate.data) return false;
    if (!validate.data.passages_in_top_k) return false;
    if (!validate.data.answer_text_in_passages) return false;
    if (!draft.failure_category) return false;
    return true;
  }, [validate.data, draft.failure_category]);

  const onSave = async () => {
    if (!canSave || draft.failure_category === "") return;
    try {
      const resp = await seedSave.mutateAsync({
        question: draft.question,
        ground_truth: draft.ground_truth,
        passages: draft.passages,
        failure_category: draft.failure_category,
        notes: draft.notes,
        draft_id: draft.id,
      });
      pushToast(`Case saved (${resp.total_cases} / ${resp.target_n})`, "success");
      setDraft(newDraft());
      validate.reset();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save";
      pushToast(message, "error");
    }
  };

  const onDiscard = () => {
    setDraft(newDraft());
    validate.reset();
    pushToast("Started a new case", "info");
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-5">
        <Card
          title="Author a case"
          description="Type a question, search the corpus for supporting passages, write the ground-truth answer."
        >
          <div className="flex flex-col gap-5">
            <Field label="Question" required>
              {(id) => (
                <TextArea
                  id={id}
                  value={draft.question}
                  autoFocus
                  onChange={(e) => setDraft({ ...draft, question: e.target.value })}
                  placeholder="What does the corpus say about…"
                  rows={2}
                />
              )}
            </Field>

            <div>
              <h3 className="mb-2 text-sm font-medium text-slate-700">Supporting passages</h3>
              {draft.passages.length > 0 && (
                <ul className="mb-3 flex flex-col gap-1">
                  {draft.passages.map((p) => (
                    <li
                      key={`${p.path}:${p.line_start}-${p.line_end}`}
                      className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-1.5 text-xs"
                    >
                      <span className="truncate font-mono text-emerald-900">
                        {p.path}{" "}
                        <span className="text-emerald-700">
                          L{p.line_start}–{p.line_end}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => onRemovePassage(p)}
                        className="rounded p-0.5 text-emerald-700 hover:bg-emerald-100"
                        aria-label="Remove passage"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <PassagePicker
                query={draft.question}
                selected={draft.passages}
                onAdd={onAddPassage}
                onRemove={onRemovePassage}
              />
            </div>

            <Field label="Ground-truth answer" required hint="Must be supported by the selected passages.">
              {(id) => (
                <TextArea
                  id={id}
                  value={draft.ground_truth}
                  onChange={(e) => setDraft({ ...draft, ground_truth: e.target.value })}
                  placeholder="The correct answer, plain text."
                  rows={3}
                />
              )}
            </Field>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field label="Failure category" required>
                {(id) => (
                  <Select
                    id={id}
                    value={draft.failure_category}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        failure_category: e.target.value as FailureCategory | "",
                      })
                    }
                  >
                    <option value="">Select…</option>
                    {FAILURE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {prettyFailureCategory(c)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Notes" hint="Optional free text for human readers.">
                {(id) => (
                  <TextArea
                    id={id}
                    rows={1}
                    value={draft.notes}
                    onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </div>
        </Card>

        <div className="flex items-center justify-between">
          <Button variant="secondary" onClick={onDiscard}>
            Discard
          </Button>
          <Button
            onClick={onSave}
            disabled={!canSave}
            loading={seedSave.isPending}
            title={!canSave ? "Resolve validation issues + select a failure category to save" : undefined}
          >
            <Save className="h-4 w-4" />
            Save case
          </Button>
        </div>
      </div>

      <div className="lg:sticky lg:top-4 lg:self-start">
        <ValidationPanel
          result={validate.data ?? null}
          isLoading={validate.isPending}
          isError={validate.isError}
          errorMessage={validate.error?.message}
          runPipeline={runPipeline}
          onToggleRunPipeline={setRunPipeline}
        />
      </div>
    </div>
  );
}
