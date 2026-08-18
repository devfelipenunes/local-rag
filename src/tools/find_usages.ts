import { qd, colName, CODE_VECTORS } from "../qdrant.js";
import { embedOne } from "../embedder.js";
import { cfg, getProjectId, getCurrentBranchCached } from "../config.js";
import { getProjectDir } from "../request-context.js";
import { isGitRepo, getCurrentBranch } from "../indexer/git.js";
import type { Schemas } from "@qdrant/js-client-rest";

type ScoredPoint = Schemas["ScoredPoint"];

type Leg = "lexical" | "import-graph" | "semantic";

/** Branch da request: git real do projectDir → global (se não "default"). */
function resolveRequestBranch(): string | undefined {
  const dir = getProjectDir();
  if (dir && isGitRepo(dir)) {
    const b = getCurrentBranch(dir);
    if (b && b !== "default") return b;
  }
  const cached = getCurrentBranchCached();
  return cached && cached !== "default" ? cached : undefined;
}

export interface FindUsagesArgs { symbol_id: string; limit: number; }

export async function findUsagesTool(a: FindUsagesArgs): Promise<string> {
  const limit = Math.min(a.limit > 0 ? a.limit : 20, 50);

  // 1. Retrieve target symbol
  const pts = await qd.retrieve(colName("code_chunks"), {
    ids: [a.symbol_id], with_payload: true, with_vector: false,
  }).catch((): never[] => []);
  if (pts.length === 0) return `Symbol '${a.symbol_id}' not found.`;

  const p         = (pts[0].payload ?? {}) as Record<string, unknown>;
  const name      = String(p["name"]      ?? "");
  const signature = String(p["signature"] ?? name);
  const filePath  = String(p["file_path"] ?? "");
  if (!name) return `Symbol '${a.symbol_id}' has no name.`;

  // Branch da request, derivada do git real do diretório — o getCurrentBranchCached()
  // global fica "default" em servidor multi-projeto e faria o filtro branches excluir
  // tudo. Sem branch resolvida → sem filtro de branch.
  const branchFilter = resolveRequestBranch();
  const projectMust = [{ key: "project_id", match: { value: getProjectId() } }];
  if (branchFilter) {
    projectMust.push({ key: "branches", match: { value: branchFilter } });
  }
  const projectFilter = { must: projectMust };

  // Lexical: only search content — searching `name` field finds same-named
  // symbols in other files (definitions), not actual usages.
  const lexFilter = {
    must: [
      ...projectFilter.must,
      { should: [{ key: "content", match: { text: name } }] },
    ],
  };

  const embedding = await embedOne(signature);

  // Three legs in parallel: lexical + import-graph + semantic
  const [lexHits, semHits, importGraphHits] = await Promise.all([
    // Lexical: chunks whose content mentions the symbol name
    qd.search(colName("code_chunks"), {
      vector: { name: CODE_VECTORS.code, vector: embedding },
      filter: lexFilter, limit, with_payload: true,
    }).catch((): ScoredPoint[] => []),

    // Semantic: conceptual similarity
    qd.search(colName("code_chunks"), {
      vector: { name: CODE_VECTORS.description, vector: embedding },
      filter: projectFilter, limit, with_payload: true, score_threshold: 0.45,
    }).catch((): ScoredPoint[] => []),

    // Import-graph: chunks from files that import the target file.
    // Catches default exports and re-exports regardless of local alias.
    filePath
      ? qd.search(colName("code_chunks"), {
          vector: { name: CODE_VECTORS.code, vector: embedding },
          filter: {
            must: [
              { key: "project_id", match: { value: getProjectId() } },
              ...(branchFilter
                ? [{ key: "branches", match: { value: branchFilter } }]
                : []),
              { key: "imports",    match: { value: filePath      } },
            ],
          },
          limit, with_payload: true, score_threshold: 0.25,
        }).catch((): ScoredPoint[] => [])
      : Promise.resolve([] as ScoredPoint[]),
  ]);

  // Merge: lexical → import-graph → semantic; dedup; exclude self.
  // Import-graph: cap at 2 chunks per importing file to avoid flooding.
  const seen = new Set<string | number>([a.symbol_id]);
  const merged: Array<{ hit: ScoredPoint; leg: Leg }> = [];

  for (const hit of lexHits) {
    if (!seen.has(hit.id)) { seen.add(hit.id); merged.push({ hit, leg: "lexical" }); }
  }

  const importFileCount = new Map<string, number>();
  for (const hit of importGraphHits) {
    if (seen.has(hit.id)) continue;
    const hp = (hit.payload ?? {}) as Record<string, unknown>;
    const fp = String(hp["file_path"] ?? "");
    const count = importFileCount.get(fp) ?? 0;
    if (count >= 2) continue;
    importFileCount.set(fp, count + 1);
    seen.add(hit.id);
    merged.push({ hit, leg: "import-graph" });
  }

  for (const hit of semHits) {
    if (!seen.has(hit.id)) { seen.add(hit.id); merged.push({ hit, leg: "semantic" }); }
  }

  if (merged.length === 0) return `No usages found for '${name}' (${filePath}).`;

  const lines: string[] = [`Usages of '${name}' (${filePath}): ${merged.length} result(s)\n`];
  for (const { hit, leg } of merged.slice(0, limit)) {
    const hp  = (hit.payload ?? {}) as Record<string, unknown>;
    lines.push(`--- [${leg}] ${hp["chunk_type"] ?? "?"} ---`);
    lines.push(`id:   ${hit.id}`);
    lines.push(`file: ${hp["file_path"] ?? "?"}:${hp["start_line"] ?? "?"}-${hp["end_line"] ?? "?"}`);
    if (hp["name"])      lines.push(`name: ${hp["name"]}`);
    if (hp["signature"]) lines.push(`sig:  ${hp["signature"]}`);
    const code = String(hp["content"] ?? "");
    lines.push(`\`\`\`\n${code.length > 400 ? code.slice(0, 400) + "\n  ... (truncated)" : code}\n\`\`\`\n`);
  }
  return lines.join("\n");
}
