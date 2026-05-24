import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Save,
  Quote,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Field, Select, TextArea } from "@/components/Field";
import { Button } from "@/components/Button";
import { Spinner } from "@/components/Spinner";
import {
  useCorpusFiles,
  useCorpusPassagesPaginated,
  useSaveDraft,
  useSeedSave,
  useSeedValidate,
} from "@/api/hooks";
import { useUIStore } from "@/store/uiStore";
import {
  FAILURE_CATEGORIES,
  FAILURE_CATEGORY_LABELS,
  type FailureCategory,
  type Passage,
} from "@/api/types";
import { cn } from "@/lib/cn";
import { useDebounce } from "@/lib/useDebounce";
import { ValidationPanel } from "./ValidationPanel";

/**
 * SME-friendly authoring flow.
 *
 * The original (question-first) wizard requires the author to know what's
 * in the corpus *before* typing a question. That mental model doesn't fit
 * subject-matter experts, who know the content and need help discovering
 * what *kind* of question the corpus can answer.
 *
 * This wizard inverts the flow:
 *
 *   1. Pick a file from the left rail.
 *   2. Scroll through that file's passages (10-line windows) and click one.
 *   3. Write a question whose answer is in that passage.
 *   4. Write the answer in the author's own words.
 *   5. Pick a friendly failure category.
 *
 * The supporting-passage is selected by construction, so the "passages are
 * retrievable" validation row is essentially guaranteed; the author still
 * sees the validation panel because the "answer text appears in passages"
 * check is a real signal worth surfacing.
 */

interface PassageKey {
  path: string;
  line_start: number;
  line_end: number;
}

interface DraftLocal {
  id: string;
  selectedFile: string | null;
  selectedPassage: Passage | null;
  question: string;
  ground_truth: string;
  failure_category: FailureCategory | "";
  notes: string;
}

function newDraft(): DraftLocal {
  return {
    id: crypto.randomUUID(),
    selectedFile: null,
    selectedPassage: null,
    question: "",
    ground_truth: "",
    failure_category: "",
    notes: "",
  };
}

function sameRef(a: PassageKey, b: PassageKey): boolean {
  return a.path === b.path && a.line_start === b.line_start && a.line_end === b.line_end;
}

const PAGE_LIMIT = 20;
const AUTOSAVE_INTERVAL_MS = 2000;
const VALIDATE_DEBOUNCE_MS = 600;

export function CaseWizardFromCorpus() {
  const [draft, setDraft] = useState<DraftLocal>(() => newDraft());
  const [page, setPage] = useState(0);
  const [runPipeline, setRunPipeline] = useState(false);
  const pushToast = useUIStore((s) => s.pushToast);

  const files = useCorpusFiles();
  const passages = useCorpusPassagesPaginated(
    draft.selectedFile,
    page * PAGE_LIMIT,
    PAGE_LIMIT,
  );

  const saveDraft = useSaveDraft();
  const seedSave = useSeedSave();
  const validate = useSeedValidate();

  // Autosave the draft so the SME never loses work between page reloads.
  // We persist the draft even though the wizard's shape differs from the
  // question-first one — the backend `SeedDraft` schema is permissive enough.
  const lastSerializedRef = useRef<string>("");
  useEffect(() => {
    const interval = setInterval(() => {
      const passagesRefs = draft.selectedPassage
        ? [
            {
              path: draft.selectedPassage.path,
              line_start: draft.selectedPassage.line_start,
              line_end: draft.selectedPassage.line_end,
            },
          ]
        : [];
      const serialized = JSON.stringify({
        question: draft.question,
        ground_truth: draft.ground_truth,
        passages: passagesRefs,
        failure_category: draft.failure_category || null,
        notes: draft.notes,
      });
      const hasContent =
        draft.question.trim() ||
        draft.ground_truth.trim() ||
        passagesRefs.length > 0;
      if (hasContent && serialized !== lastSerializedRef.current) {
        lastSerializedRef.current = serialized;
        saveDraft.mutate({
          id: draft.id,
          draft: {
            question: draft.question,
            ground_truth: draft.ground_truth,
            passages: passagesRefs,
            failure_category:
              draft.failure_category === "" ? null : draft.failure_category,
            notes: draft.notes,
          },
        });
      }
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [draft, saveDraft]);

  // Debounced validation. Different from the question-first wizard: a passage
  // is selected by clicking, not by typing, so we only need the question and
  // ground-truth to debounce on.
  const debouncedDraft = useDebounce(
    {
      question: draft.question,
      ground_truth: draft.ground_truth,
      passageKey: draft.selectedPassage
        ? `${draft.selectedPassage.path}:${draft.selectedPassage.line_start}-${draft.selectedPassage.line_end}`
        : null,
      runPipeline,
    },
    VALIDATE_DEBOUNCE_MS,
  );

  useEffect(() => {
    if (
      debouncedDraft.question.trim().length >= 3 &&
      debouncedDraft.ground_truth.trim().length >= 1 &&
      draft.selectedPassage
    ) {
      validate.mutate({
        question: debouncedDraft.question,
        ground_truth: debouncedDraft.ground_truth,
        passages: [
          {
            path: draft.selectedPassage.path,
            line_start: draft.selectedPassage.line_start,
            line_end: draft.selectedPassage.line_end,
          },
        ],
        run_pipeline: debouncedDraft.runPipeline,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debouncedDraft.question,
    debouncedDraft.ground_truth,
    debouncedDraft.passageKey,
    debouncedDraft.runPipeline,
  ]);

  const canSave = useMemo(() => {
    if (!draft.selectedPassage) return false;
    if (!validate.data) return false;
    // The "answer is in the passage" check is the real load-bearing one for
    // this flow — the passage being in top-k is trivially true once you've
    // picked it from the corpus, so we still gate on it but it should always
    // pass.
    if (!validate.data.passages_in_top_k) return false;
    if (!validate.data.answer_text_in_passages) return false;
    if (!draft.failure_category) return false;
    return true;
  }, [draft.selectedPassage, draft.failure_category, validate.data]);

  const onSelectFile = (path: string) => {
    setDraft((d) => ({ ...d, selectedFile: path, selectedPassage: null }));
    setPage(0);
    validate.reset();
  };

  const onSelectPassage = (p: Passage) => {
    setDraft((d) => ({ ...d, selectedPassage: p }));
  };

  const onSave = async () => {
    if (!canSave || draft.failure_category === "" || !draft.selectedPassage) return;
    try {
      const resp = await seedSave.mutateAsync({
        question: draft.question,
        ground_truth: draft.ground_truth,
        passages: [
          {
            path: draft.selectedPassage.path,
            line_start: draft.selectedPassage.line_start,
            line_end: draft.selectedPassage.line_end,
          },
        ],
        failure_category: draft.failure_category,
        notes: draft.notes,
        draft_id: draft.id,
      });
      pushToast(`Case saved (${resp.total_cases} / ${resp.target_n})`, "success");
      // Keep the file selection so the SME can quickly author another case
      // from the same document — reset only the per-case fields.
      setDraft((d) => ({
        ...newDraft(),
        selectedFile: d.selectedFile,
      }));
      validate.reset();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save";
      pushToast(message, "error");
    }
  };

  const onDiscard = () => {
    setDraft((d) => ({ ...newDraft(), selectedFile: d.selectedFile }));
    validate.reset();
    pushToast("Started a new case", "info");
  };

  const totalWindows = passages.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalWindows / PAGE_LIMIT));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr_360px]">
      {/* Left rail — file browser */}
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <Card
          title={
            <span className="inline-flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-slate-500" /> Corpus files
            </span>
          }
        >
          <div
            className="max-h-[60vh] overflow-y-auto"
            data-testid="from-corpus-file-list"
          >
            {files.isLoading ? (
              <div className="flex justify-center py-6">
                <Spinner size="sm" />
              </div>
            ) : files.isError ? (
              <p className="text-xs text-red-600">Failed to load corpus.</p>
            ) : !files.data || files.data.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-500">
                No files in corpus. Drop documents into your corpus path and
                ingest.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {files.data.map((f) => {
                  const active = draft.selectedFile === f.path;
                  return (
                    <li key={f.path}>
                      <button
                        type="button"
                        onClick={() => onSelectFile(f.path)}
                        className={cn(
                          "w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                          active
                            ? "bg-brand-100 text-brand-900"
                            : "text-slate-700 hover:bg-slate-50",
                        )}
                        title={f.path}
                        aria-pressed={active}
                        data-testid="from-corpus-file"
                      >
                        <div className="truncate font-medium">{f.path}</div>
                        <div className="text-[10px] text-slate-500">
                          {f.ingested && f.n_chunks != null ? (
                            <span>{f.n_chunks} chunks</span>
                          ) : (
                            <span className="text-amber-600">not ingested</span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>
      </aside>

      {/* Middle column — passage picker + form */}
      <main className="flex flex-col gap-5">
        <Card
          title="1. Pick a passage"
          description="Click a passage to anchor a new case. Each passage is roughly 10 source lines from the file you selected."
        >
          {!draft.selectedFile ? (
            <p className="py-6 text-center text-sm text-slate-500">
              Select a file on the left to browse its passages.
            </p>
          ) : passages.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : passages.isError ? (
            <p className="text-xs text-red-600">
              Failed to load passages: {passages.error.message}
            </p>
          ) : !passages.data || passages.data.passages.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-500">
              No passages in this file.
            </p>
          ) : (
            <>
              <ul
                className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto"
                data-testid="from-corpus-passage-list"
              >
                {passages.data.passages.map((p) => {
                  const isSelected =
                    !!draft.selectedPassage && sameRef(draft.selectedPassage, p);
                  return (
                    <li key={`${p.path}:${p.line_start}-${p.line_end}`}>
                      <button
                        type="button"
                        onClick={() => onSelectPassage(p)}
                        className={cn(
                          "w-full rounded-xl border p-3 text-left text-xs transition-colors",
                          isSelected
                            ? "border-emerald-400 bg-emerald-50"
                            : "border-slate-200 bg-white hover:border-brand-300 hover:bg-brand-50",
                        )}
                        data-testid="from-corpus-passage"
                        aria-pressed={isSelected}
                      >
                        <div className="mb-1 flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[10px] text-slate-500">
                            L{p.line_start}–{p.line_end}
                          </span>
                          {isSelected && (
                            <span className="rounded bg-emerald-200 px-1.5 py-0.5 text-[10px] font-medium text-emerald-900">
                              Anchored
                            </span>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap text-slate-700">
                          {p.content}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-3 flex items-center justify-between text-xs text-slate-600">
                <span>
                  Showing {page * PAGE_LIMIT + 1}–
                  {Math.min((page + 1) * PAGE_LIMIT, totalWindows)} of{" "}
                  {totalWindows} passages
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Prev
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                    disabled={page >= totalPages - 1}
                    aria-label="Next page"
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>

        {/* Anchored-passage banner + question/answer authoring */}
        <Card
          title="2. Write the question and answer"
          description={
            draft.selectedPassage
              ? "Use the passage above as the source of truth."
              : "Pick a passage to begin."
          }
        >
          {draft.selectedPassage && (
            <div
              className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3"
              data-testid="anchored-passage"
            >
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-emerald-900">
                <Quote className="h-3.5 w-3.5" />
                <span className="truncate font-mono">
                  {draft.selectedPassage.path}{" "}
                  <span className="font-normal text-emerald-700">
                    L{draft.selectedPassage.line_start}–
                    {draft.selectedPassage.line_end}
                  </span>
                </span>
              </div>
              <p className="whitespace-pre-wrap text-xs text-emerald-900">
                {draft.selectedPassage.content}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-5">
            <Field
              label="Question"
              required
              hint="What question would a user ask whose answer is in this passage?"
            >
              {(id) => (
                <TextArea
                  id={id}
                  value={draft.question}
                  onChange={(e) =>
                    setDraft({ ...draft, question: e.target.value })
                  }
                  placeholder="A question the corpus can answer."
                  rows={2}
                  disabled={!draft.selectedPassage}
                />
              )}
            </Field>

            <Field
              label="Ground-truth answer"
              required
              hint="In your own words, what does this passage say in answer to your question?"
            >
              {(id) => (
                <TextArea
                  id={id}
                  value={draft.ground_truth}
                  onChange={(e) =>
                    setDraft({ ...draft, ground_truth: e.target.value })
                  }
                  placeholder="The correct answer, plain text. Must appear (verbatim or as a substring) in the passage."
                  rows={3}
                  disabled={!draft.selectedPassage}
                />
              )}
            </Field>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field label="Category" required>
                {(id) => (
                  <>
                    <Select
                      id={id}
                      value={draft.failure_category}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          failure_category: e.target.value as
                            | FailureCategory
                            | "",
                        })
                      }
                      disabled={!draft.selectedPassage}
                    >
                      <option value="">Select…</option>
                      {FAILURE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {FAILURE_CATEGORY_LABELS[c].label}
                        </option>
                      ))}
                    </Select>
                    {draft.failure_category && (
                      <p
                        className="mt-1 text-xs text-slate-500"
                        data-testid="category-description"
                      >
                        {
                          FAILURE_CATEGORY_LABELS[draft.failure_category]
                            .description
                        }
                      </p>
                    )}
                  </>
                )}
              </Field>
              <Field label="Notes" hint="Optional free text for human readers.">
                {(id) => (
                  <TextArea
                    id={id}
                    rows={1}
                    value={draft.notes}
                    onChange={(e) =>
                      setDraft({ ...draft, notes: e.target.value })
                    }
                    disabled={!draft.selectedPassage}
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
            title={
              !canSave
                ? "Pick a passage, write the question + answer, and choose a category."
                : undefined
            }
          >
            <Save className="h-4 w-4" />
            Save case
          </Button>
        </div>
      </main>

      {/* Right column — validation */}
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <ValidationPanel
          result={validate.data ?? null}
          isLoading={validate.isPending}
          isError={validate.isError}
          errorMessage={validate.error?.message}
          runPipeline={runPipeline}
          onToggleRunPipeline={setRunPipeline}
        />
      </aside>
    </div>
  );
}
