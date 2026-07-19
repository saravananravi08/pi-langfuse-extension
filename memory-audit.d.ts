export interface AuditTrace {
  id: string;
  name?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditScore {
  id: string;
  name: string;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ObservationAudit {
  traces: number;
  observedTraces: number;
  observationScores: number;
  eligibleMissing: number;
  preCoverage: number;
  intentionallySkipped: number;
  duplicateTraces: number;
  nonDeterministicScores: number;
  promptVersions: Record<string, number>;
  paths: Record<string, { traces: number; observed: number; eligibleMissing: number; preCoverage: number; intentionallySkipped: number }>;
  coverageStart: string | null;
  eligibleMissingTraceIds: string[];
  preCoverageTraceIds: string[];
  intentionallySkippedTraceIds: string[];
  duplicateTraceIds: string[];
  nonDeterministicScoreIds: string[];
}

export function auditObservationCoverage(traces: AuditTrace[], scores: AuditScore[], options: {
  scoreName: string;
  version: string;
  expectedScoreId(traceId: string): string;
}): ObservationAudit;
