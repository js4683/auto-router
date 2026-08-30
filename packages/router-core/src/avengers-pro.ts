import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AvengersProArtifacts {
  nClusters: number;
  embeddingModel: string;
  availableModels: string[];
  topK: number;
  beta: number;
  centers: number[][];
  rankings: Record<number, { ranking: string[]; scores?: Record<string, number> }>;
}

export type EmbedQuery = (text: string) => Promise<number[]>;

export function loadAvengersProArtifacts(dir: string): AvengersProArtifacts {
  const metadata = JSON.parse(readFileSync(resolve(dir, "metadata.json"), "utf8")) as {
    n_clusters: number;
    embedding_model: string;
    available_models: string[];
    top_k: number;
    beta: number;
  };
  const centers = JSON.parse(readFileSync(resolve(dir, "cluster_centers.json"), "utf8")) as number[][];
  const rankings = JSON.parse(readFileSync(resolve(dir, "cluster_rankings.json"), "utf8")) as AvengersProArtifacts["rankings"];
  return {
    nClusters: metadata.n_clusters,
    embeddingModel: metadata.embedding_model,
    availableModels: metadata.available_models,
    topK: metadata.top_k,
    beta: metadata.beta,
    centers,
    rankings,
  };
}

export function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec.slice();
  return vec.map((v) => v / norm);
}

function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

export function scoreAvengersPro(
  embedding: number[],
  artifacts: AvengersProArtifacts
): { paperIds: string[]; scores: Record<string, number> } {
  const normalized = l2Normalize(embedding);
  const distances = artifacts.centers.map((center, index) => ({
    index,
    distance: 1 - dot(normalized, l2Normalize(center)),
  }));
  distances.sort((a, b) => a.distance - b.distance);
  const top = distances.slice(0, Math.max(1, artifacts.topK));
  const logits = top.map((item) => -artifacts.beta * item.distance);
  const maxLogit = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp(logit - maxLogit));
  const sumExp = exps.reduce((sum, value) => sum + value, 0);
  const probs = exps.map((value) => value / sumExp);

  const scores: Record<string, number> = {};
  for (const model of artifacts.availableModels) scores[model] = 0;
  for (let i = 0; i < top.length; i++) {
    const ranking = artifacts.rankings[top[i].index]?.ranking ?? [];
    for (const model of artifacts.availableModels) {
      const rank = ranking.indexOf(model);
      const rankScore = rank >= 0 ? 1 / (rank + 1) : 0;
      scores[model] += probs[i] * rankScore;
    }
  }

  const paperIds = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  return { paperIds, scores };
}

export async function rankAvengersPro(
  text: string,
  artifacts: AvengersProArtifacts,
  embed: EmbedQuery
): Promise<{ paperIds: string[]; scores: Record<string, number> }> {
  const embedding = await embed(text);
  return scoreAvengersPro(l2Normalize(embedding), artifacts);
}
