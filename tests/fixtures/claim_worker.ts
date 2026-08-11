import {
  CalculixRunOutcomeUnknownError,
  CalculixRunStore,
} from "../../src/runs.ts";

const [runsDirectory, requestId, requestJson, workerId] = Deno.args;
if (!runsDirectory || !requestId || !requestJson || !workerId) {
  throw new Error(
    "Expected runsDirectory, requestId, requestJson and workerId.",
  );
}

// Construct both stores before the parent opens the barrier. This models two
// already-running provider processes contending for the same durable identity.
const store = new CalculixRunStore({ runsDirectory });
await Deno.writeTextFile(`${runsDirectory}/ready-${workerId}`, "ready\n");
while (true) {
  try {
    await Deno.stat(`${runsDirectory}/start`);
    break;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

try {
  const result = await store.claimRequest(requestId, requestJson);
  console.log(JSON.stringify({ outcome: result.outcome }));
} catch (error) {
  if (error instanceof CalculixRunOutcomeUnknownError) {
    console.log(JSON.stringify({ outcome: "refused", state: error.state }));
  } else {
    throw error;
  }
}
