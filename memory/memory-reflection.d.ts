export interface ReflectionFields {
  summary?: string;
  goal?: string[];
  constraints?: string[];
  currentTask?: string;
  taskStatus?: string;
  completed?: string[];
  inProgress?: string[];
  openIssues?: string[];
  decisions?: string[];
  nextSteps?: string[];
  criticalContext?: string[];
  filesRead?: string[];
  filesModified?: string[];
  filesCreated?: string[];
  filesDeleted?: string[];
  toolsUsed?: string[];
}

export interface ReflectionQuality {
  errors: string[];
  metrics: {
    deterministicMarkdown: true;
    sourceNonEmptyFieldCount: number;
    retainedNonEmptyFieldCount: number;
    fieldRetentionRatio: number;
    missingSourceFields: string[];
    structuredItemCount: number;
    duplicateItemCount: number;
    duplicateFields: string[];
    contradictionCount: number;
    durableItemCount: number;
    lostUserItemCount: number;
  };
}

export function renderReflectionMarkdown(fields: Record<string, unknown>, options?: { maxTokens?: number }): string;
export function normalizeReflectionTaskStatus(fields: Record<string, unknown>): Record<string, unknown>;
export function evaluateReflectionQuality(output: Record<string, unknown>, previous: Record<string, unknown> | null, observations: Record<string, unknown>[]): ReflectionQuality;
