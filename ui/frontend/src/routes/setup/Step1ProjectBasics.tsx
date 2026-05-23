import { useEffect, useState } from "react";
import { Card } from "@/components/Card";
import { Field, TextInput } from "@/components/Field";
import type { BratanConfig, ProjectBasics } from "@/api/types";
import { useAutoSaveStep } from "./useAutoSaveStep";

interface Props {
  config: BratanConfig | null;
}

const DEFAULTS: ProjectBasics = {
  project_name: "rag-refiner",
  corpus_path: "./corpus",
  seed_target_n: 50,
};

export function Step1ProjectBasics({ config }: Props) {
  const [data, setData] = useState<ProjectBasics>(config?.project ?? DEFAULTS);

  useEffect(() => {
    if (config?.project) setData(config.project);
  }, [config]);

  useAutoSaveStep(1, data);

  return (
    <Card
      title="Project basics"
      description="Name your project and tell us where the source documents live."
    >
      <div className="flex flex-col gap-5">
        <Field
          label="Project name"
          required
          hint="A short identifier used in commit messages and report filenames."
        >
          {(id) => (
            <TextInput
              id={id}
              value={data.project_name}
              onChange={(e) => setData({ ...data, project_name: e.target.value })}
              placeholder="my-rag-project"
              autoFocus
            />
          )}
        </Field>

        <Field
          label="Corpus path"
          required
          hint="Filesystem path to the documents the pipeline answers from. Relative paths resolve against the project root."
        >
          {(id) => (
            <TextInput
              id={id}
              value={data.corpus_path}
              onChange={(e) => setData({ ...data, corpus_path: e.target.value })}
              placeholder="./corpus"
            />
          )}
        </Field>
      </div>
    </Card>
  );
}
