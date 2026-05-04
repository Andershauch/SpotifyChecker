import { start } from "workflow/api";
import { updateCheckJob } from "@/lib/db";
import { type CheckRunOptions, type CheckTriggerSource } from "@/lib/checker";
import {
  runSpotifyCheckWorkflow,
  type SpotifyCheckWorkflowInput,
} from "@/workflows/spotify-check";

export async function startCheckWorkflowRun(input: {
  jobId: string;
  triggerSource: CheckTriggerSource;
  options?: CheckRunOptions;
}) {
  const workflowInput: SpotifyCheckWorkflowInput = {
    jobId: input.jobId,
    triggerSource: input.triggerSource,
    options: input.options,
  };

  const run = await start(runSpotifyCheckWorkflow, [workflowInput]);

  await updateCheckJob(input.jobId, {
    payload: {
      workflowRunId: run.runId,
      workflowStatus: "started",
      currentStage: "Workflow er startet på Vercel",
    },
  });

  return run.runId;
}

export async function failWorkflowKickoff(
  jobId: string,
  message: string,
) {
  await updateCheckJob(jobId, {
    status: "error",
    errorMessage: message,
    payload: {
      workflowStatus: "failed_to_start",
      currentStage: "Workflow kunne ikke startes",
    },
    finished: true,
  });
}
