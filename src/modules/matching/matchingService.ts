import path from "path";
import { buildMatchSummary } from "./matcher";
import { listHistoricalBuilds } from "../storage/buildRepository";
import { AttributeMap } from "../../types/build";

interface MatchOptions {
  excludeId?: string;
  limit?: number;
}

export async function findClosestMatches(
  attributes: AttributeMap,
  options: MatchOptions = {}
) {
  const candidates = await listHistoricalBuilds({
    excludeId: options.excludeId,
    limit: options.limit,
  });
  const scored = candidates.map((candidate) => {
    const summary = buildMatchSummary(attributes, candidate.attributes);
    return {
      ...summary,
      id: candidate._id.toString(),
      match_score: summary.match_score,
      shared_attributes: summary.shared_attributes,
      differences: summary.differences,
      link_to_file: `/files/${path.basename(candidate.filePath)}`,
      totalPrice: candidate.totalPrice,
    };
  });

  return scored
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, options.limit ?? 5);
}

