import type { AvengersProArtifactFiles } from "./avengers-pro-artifacts.js";
import type { AvengersProPrediction } from "./types.js";

export type EmbedQuery = (text: string) => Promise<number[]>;

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function canonicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeQuery(vector: number[], dimensions: number): number[] {
  if (vector.length === 0) throw new Error("query vector is empty");
  if (vector.length !== dimensions) throw new Error("query vector dimension does not match artifact");
  if (vector.some((value) => !Number.isFinite(value))) throw new Error("query vector contains a non-finite value");
  const scale = vector.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (scale === 0) throw new Error("query vector has zero norm");
  const scaledNorm = Math.sqrt(vector.reduce((sum, value) => sum + (value / scale) ** 2, 0));
  return vector.map((value) => value / scale / scaledNorm);
}

interface ClusterProbability {
  index: number;
  probability: number;
}

function topClusterProbabilities(vector: number[], artifacts: AvengersProArtifactFiles): ClusterProbability[] {
  const nearest = artifacts.centers
    .map((center, index) => ({ index, distance: 1 - dot(vector, center) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, artifacts.metadata.topK);
  const logits = nearest.map((item) => -artifacts.metadata.beta * item.distance);
  const maxLogit = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp(logit - maxLogit));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  return nearest.map((item, index) => ({ index: item.index, probability: weights[index] / totalWeight }));
}

export function scoreAvengersPro(
  vector: number[],
  artifacts: AvengersProArtifactFiles
): AvengersProPrediction {
  const normalized = normalizeQuery(vector, artifacts.metadata.embeddingDimensions);
  const clusters = topClusterProbabilities(normalized, artifacts);
  const predictedQuality: Record<string, number> = {};

  for (const model of artifacts.metadata.availableModels) {
    let weightedQuality = 0;
    let includedProbability = 0;
    for (const cluster of clusters) {
      const stat = artifacts.clusterModelStats[cluster.index]?.[model];
      if (!stat) continue;
      weightedQuality += cluster.probability * stat.qualityMean;
      includedProbability += cluster.probability;
    }
    if (includedProbability > 0) predictedQuality[model] = weightedQuality / includedProbability;
  }

  const paperIds = Object.keys(predictedQuality).sort(
    (a, b) => predictedQuality[b] - predictedQuality[a] || canonicalCompare(a, b)
  );
  return { paperIds, predictedQuality };
}

export async function rankAvengersPro(
  text: string,
  artifacts: AvengersProArtifactFiles,
  embed: EmbedQuery
): Promise<AvengersProPrediction> {
  const embedding = await embed(text);
  return scoreAvengersPro(embedding, artifacts);
}
