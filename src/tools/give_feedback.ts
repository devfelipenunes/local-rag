import { randomUUID } from "node:crypto";
import { qd, colName }              from "../qdrant.js";
import { embedOne }                  from "../embedder.js";
import { getProjectId }              from "../request-context.js";
import { getSession }                from "../session-store.js";
import { nowIso, contentHash }       from "../util.js";

export interface GiveFeedbackArgs {
  content:    string;
  session_id: string;  // optional — empty string means "use SessionStore"
  agent_type: string;  // optional — forwarded from hook CLI arg
}

export async function giveFeedbackTool(a: GiveFeedbackArgs): Promise<string> {
  const projectId = getProjectId();

  // Resolve session_id: args first, then SessionStore fallback, then "unknown"
  const sessionId = a.session_id || getSession(projectId) || "unknown";

  const id        = randomUUID();
  const now       = nowIso();
  const embedding = await embedOne(a.content);

  await qd.upsert(colName("feedback"), {
    points: [{
      id,
      vector: embedding,
      payload: {
        content:      a.content,
        session_id:   sessionId,
        project_id:   projectId,
        agent_type:   a.agent_type || "unknown",
        hook_event:   "SessionEnd",
        created_at:   now,
        content_hash: contentHash(a.content),
      },
    }],
  });

  return `feedback stored: ${id} (session=${sessionId})`;
}
