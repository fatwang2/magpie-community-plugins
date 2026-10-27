import { serviceURL, USER_AGENT } from "./types.ts";

// Agentback project public key, shared with the Search1API MCP server and CLI.
// It can only submit feedback, so it ships like any other public client key.
const AGENTBACK =
  "https://agentback.app/f/af_97385a84ecf95968db2403eb6ef165ddcd8ee6716c1b2ceb72f1a35a69e52b8e";
export const CATEGORIES = ["bug", "feature_request", "docs", "other"];

export const DESCRIPTION =
  "Report a problem with Search1API: a wrong, empty or incomplete result, an " +
  "error you could not resolve, documentation that did not match behavior, or " +
  "a capability you needed but Search1API lacks. The report (message, intent, " +
  "category, request_id and model) goes to Search1API's feedback inbox on " +
  "agentback.app, a third-party host. When the user is signed in to Search1API " +
  "it is linked to their Search1API account. Never include credentials, " +
  "personal data, file contents, or the user's conversation. Send one report " +
  "per distinct problem, after you have worked around or abandoned the step. " +
  "Do not report normal successful results. Reporting is free, optional and " +
  "must not block the user's task.";

// Search1API signs the account id so the report shows under the user's account;
// only the id and signature reach Agentback, never the credential. Without a
// working credential the report is sent without one rather than not at all.
async function identity(baseUrl: string, token: string | undefined, signal: AbortSignal) {
  if (!token) return {};
  try {
    const response = await fetch(serviceURL(`${baseUrl}/feedback/identity`), {
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {};
    }
    const body = (await response.json()) as { account?: unknown; signature?: unknown };
    return typeof body.account === "string" && typeof body.signature === "string"
      ? { account: body.account, account_signature: body.signature }
      : {};
  } catch {
    return {};
  }
}

export async function sendFeedback(
  baseUrl: string,
  token: string | undefined,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const { model, ...report } = args;
  const body = {
    ...report,
    agent: { name: "Magpie", ...(model === undefined ? {} : { model }) },
    source: "mcp",
    ...(await identity(baseUrl, token, signal)),
  };
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(AGENTBACK, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
  } catch {
    signal.throwIfAborted();
    return "Feedback was not recorded: Agentback could not be reached. Continue the task.";
  }
  const receipt = (await response.json().catch(() => null)) as { id?: unknown } | null;
  return response.status === 201 && typeof receipt?.id === "string"
    ? `Feedback recorded (${receipt.id}). Thank you.`
    : `Feedback was not recorded (HTTP ${response.status}). Continue the task.`;
}
