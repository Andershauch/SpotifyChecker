import { start } from "workflow/api";
import { updateCheckJob } from "@/lib/db";
import {
  requestCheckRun,
  type CheckRequestSummary,
  type CheckRunOptions,
  type CheckTriggerSource,
} from "@/lib/checker";
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

export async function requestAndStartCheckWorkflow(input: {
  triggerSource: CheckTriggerSource;
  options?: CheckRunOptions;
}): Promise<
  | CheckRequestSummary
  | {
      accepted: false;
      jobId: string;
      status: "workflow_failed";
      errorMessage: string;
    }
> {
  const result = await requestCheckRun(input.triggerSource);

  if (!result.accepted || !result.jobId) {
    return result;
  }

  try {
    await startCheckWorkflowRun({
      jobId: result.jobId,
      triggerSource: input.triggerSource,
      options: input.options,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? `Workflow kunne ikke startes: ${error.message}`
        : "Workflow kunne ikke startes.";
    await failWorkflowKickoff(result.jobId, message);

    return {
      accepted: false,
      jobId: result.jobId,
      status: "workflow_failed",
      errorMessage: message,
    };
  }

  return result;
}

export function getCheckWorkflowHttpStatus(result: { accepted: boolean; status: string }) {
  if (result.accepted) {
    return 202;
  }

  return result.status === "workflow_failed" ? 500 : 409;
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
