import { executeCheckJob, type CheckRunOptions, type CheckSummary, type CheckTriggerSource } from "@/lib/checker";

export type SpotifyCheckWorkflowInput = {
  jobId: string;
  triggerSource: CheckTriggerSource;
  options?: CheckRunOptions;
};

export async function runSpotifyCheckWorkflow(
  input: SpotifyCheckWorkflowInput,
): Promise<CheckSummary> {
  "use workflow";

  return executeSpotifyCheckStep(input);
}

async function executeSpotifyCheckStep(
  input: SpotifyCheckWorkflowInput,
): Promise<CheckSummary> {
  "use step";

  return executeCheckJob(input.jobId, input.options);
}
