/**
 * A session's id as Cronk keeps it, so the ways one claude.ai session is named all find the same Run and Transcript.
 *
 * claude.ai names a Claude Code on the web session `cse_…` (in its routine fire's `claude_code_session_id`, its URLs
 * and `CLAUDE_CODE_REMOTE_SESSION_ID`) and also `session_…` (as it once answered, and as the Transcript hook sends
 * it, rewriting `cse_`). Both become `cse_…`. Any other id, such as a Managed Agents `sesn_…` or Claude Code's own
 * session id, is kept as it is.
 */
export function sessionIdOf(id: string): string {
  return id.replace(/^session_(?=.)/, "cse_");
}
