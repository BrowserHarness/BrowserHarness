import { embedTexts } from "./model-client";
import {
  listTaskEpisodeMemory,
  searchTaskEpisodeMemory,
  type TaskEpisodeMemory
} from "./task-memory";
import {
  loadEmbeddingConnection,
  type ProviderConnection
} from "../settings/provider-store";

const KEY = "browsercrew.taskEpisodeVectors.v1";
const MAX_INDEX = 500;
const MAX_REINDEX_PER_SEARCH = 32;
const INDEX_SOURCE_LIMIT = 100;

export interface TaskEpisodeVectorRecord {
  episode_id: string;
  connection_id: string;
  model: string;
  dimensions: number;
  content_hash: string;
  indexed_at: string;
  vector: number[];
}

export interface TaskMemorySearchHit {
  episode: TaskEpisodeMemory;
  score: number;
  lexical_rank?: number;
  semantic_rank?: number;
  semantic_similarity?: number;
  retrieval: Array<"lexical" | "semantic">;
}

function bounded(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function taskEpisodeEmbeddingText(
  episode: TaskEpisodeMemory
): string {
  return [
    `title: ${bounded(episode.title, 240)}`,
    `task: ${bounded(episode.task, 1200)}`,
    `status: ${episode.status}`,
    `sites: ${episode.sites.join(" ")}`,
    `tools: ${episode.tools.join(" ")}`,
    `targets: ${episode.targets.join(" ")}`,
    `skills: ${episode.skill_refs
      .map((ref) =>
        [ref.id, ref.action, ref.revision_id || ""]
          .filter(Boolean)
          .join(" ")
      )
      .join(" ")}`
  ].join("\n");
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cosineSimilarity(
  left: number[],
  right: number[]
): number | null {
  if (
    !left.length ||
    left.length !== right.length
  ) {
    return null;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (!leftNorm || !rightNorm) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

async function loadIndex(): Promise<TaskEpisodeVectorRecord[]> {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY])
    ? (stored[KEY] as TaskEpisodeVectorRecord[]).filter(
        (item) =>
          item &&
          typeof item.episode_id === "string" &&
          typeof item.connection_id === "string" &&
          Array.isArray(item.vector)
      )
    : [];
}

async function saveIndex(
  records: TaskEpisodeVectorRecord[]
): Promise<void> {
  await chrome.storage.local.set({
    [KEY]: records.slice(0, MAX_INDEX)
  });
}

function currentRecord(
  records: TaskEpisodeVectorRecord[],
  episode: TaskEpisodeMemory,
  connection: ProviderConnection
): TaskEpisodeVectorRecord | null {
  const hash = stableHash(taskEpisodeEmbeddingText(episode));
  return (
    records.find(
      (record) =>
        record.episode_id === episode.id &&
        record.connection_id === connection.id &&
        record.model === connection.model &&
        record.content_hash === hash
    ) || null
  );
}

async function indexEpisodes(
  connection: ProviderConnection,
  episodes: TaskEpisodeMemory[],
  existing: TaskEpisodeVectorRecord[]
): Promise<TaskEpisodeVectorRecord[]> {
  const missing = episodes
    .filter(
      (episode) =>
        !currentRecord(existing, episode, connection)
    )
    .slice(0, MAX_REINDEX_PER_SEARCH);

  if (!missing.length) return existing;

  const texts = missing.map(taskEpisodeEmbeddingText);
  const result = await embedTexts(
    connection,
    texts
  );

  const indexedAt = new Date().toISOString();
  const replacements = missing.map(
    (episode, index): TaskEpisodeVectorRecord => ({
      episode_id: episode.id,
      connection_id: connection.id,
      model: connection.model,
      dimensions: result.dimensions,
      content_hash: stableHash(texts[index]),
      indexed_at: indexedAt,
      vector: result.vectors[index]
    })
  );
  const replacementIds = new Set(
    replacements.map(
      (record) =>
        `${record.episode_id}\u0000${record.connection_id}`
    )
  );

  const next = [
    ...replacements,
    ...existing.filter(
      (record) =>
        !replacementIds.has(
          `${record.episode_id}\u0000${record.connection_id}`
        )
    )
  ].slice(0, MAX_INDEX);

  await saveIndex(next);
  return next;
}

export async function indexTaskEpisodeMemory(
  episode: TaskEpisodeMemory
): Promise<TaskEpisodeVectorRecord | null> {
  const connection = await loadEmbeddingConnection();
  if (!connection) return null;

  const existing = await loadIndex();
  const next = await indexEpisodes(
    connection,
    [episode],
    existing
  );
  return currentRecord(next, episode, connection);
}

function rrf(rank: number): number {
  return 1 / (60 + rank);
}

function lexicalHits(
  episodes: TaskEpisodeMemory[],
  limit: number
): TaskMemorySearchHit[] {
  return episodes.slice(0, limit).map(
    (episode, index) => ({
      episode,
      score: rrf(index + 1),
      lexical_rank: index + 1,
      retrieval: ["lexical"]
    })
  );
}

export async function searchTaskMemoryHybrid(
  query: string,
  limit = 10
): Promise<TaskMemorySearchHit[]> {
  const boundedLimit = Math.min(
    Math.max(Math.round(Number(limit) || 10), 1),
    25
  );
  const lexical = await searchTaskEpisodeMemory(
    query,
    Math.min(25, Math.max(boundedLimit * 3, 10))
  );

  const connection = await loadEmbeddingConnection();
  if (!connection) {
    return lexicalHits(lexical, boundedLimit);
  }

  let source: TaskEpisodeMemory[];
  let index: TaskEpisodeVectorRecord[];
  let queryEmbedding: Awaited<ReturnType<typeof embedTexts>>;

  try {
    source = await listTaskEpisodeMemory(
      INDEX_SOURCE_LIMIT
    );
    index = await loadIndex();
    index = await indexEpisodes(
      connection,
      source,
      index
    );
    queryEmbedding = await embedTexts(
      connection,
      [bounded(query, 1000)]
    );
  } catch {
    return lexicalHits(lexical, boundedLimit);
  }
  const queryVector = queryEmbedding.vectors[0];

  const semantic = source
    .map((episode) => {
      const record = currentRecord(
        index,
        episode,
        connection
      );
      if (
        !record ||
        record.dimensions !== queryEmbedding.dimensions
      ) {
        return null;
      }
      const similarity = cosineSimilarity(
        queryVector,
        record.vector
      );
      return similarity === null
        ? null
        : { episode, similarity };
    })
    .filter(
      (
        item
      ): item is {
        episode: TaskEpisodeMemory;
        similarity: number;
      } => Boolean(item)
    )
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        right.episode.recorded_at.localeCompare(
          left.episode.recorded_at
        )
    );

  const combined = new Map<
    string,
    {
      episode: TaskEpisodeMemory;
      score: number;
      lexical_rank?: number;
      semantic_rank?: number;
      semantic_similarity?: number;
      retrieval: Set<"lexical" | "semantic">;
    }
  >();

  lexical.forEach((episode, index) => {
    combined.set(episode.id, {
      episode,
      score: rrf(index + 1),
      lexical_rank: index + 1,
      retrieval: new Set(["lexical"])
    });
  });

  semantic.forEach((item, index) => {
    const existing = combined.get(item.episode.id);
    if (existing) {
      existing.score += rrf(index + 1);
      existing.semantic_rank = index + 1;
      existing.semantic_similarity = item.similarity;
      existing.retrieval.add("semantic");
    } else {
      combined.set(item.episode.id, {
        episode: item.episode,
        score: rrf(index + 1),
        semantic_rank: index + 1,
        semantic_similarity: item.similarity,
        retrieval: new Set(["semantic"])
      });
    }
  });

  return [...combined.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.episode.recorded_at.localeCompare(
          left.episode.recorded_at
        )
    )
    .slice(0, boundedLimit)
    .map((item) => ({
      episode: structuredClone(item.episode),
      score: item.score,
      ...(item.lexical_rank
        ? { lexical_rank: item.lexical_rank }
        : {}),
      ...(item.semantic_rank
        ? { semantic_rank: item.semantic_rank }
        : {}),
      ...(typeof item.semantic_similarity === "number"
        ? {
            semantic_similarity:
              item.semantic_similarity
          }
        : {}),
      retrieval: [...item.retrieval]
    }));
}

export async function deleteTaskEpisodeVector(
  episodeId: string
): Promise<void> {
  const current = await loadIndex();
  await saveIndex(
    current.filter(
      (record) => record.episode_id !== episodeId
    )
  );
}

export async function getTaskEpisodeVector(
  episodeId: string
): Promise<TaskEpisodeVectorRecord[]> {
  return (await loadIndex())
    .filter((record) => record.episode_id === episodeId)
    .map((record) => structuredClone(record));
}

export const TASK_EPISODE_VECTOR_KEY = KEY;
