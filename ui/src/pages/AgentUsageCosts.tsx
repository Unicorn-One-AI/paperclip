import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BudgetPolicySummary, CostByAgentModel } from "@paperclipai/shared";
import { ChevronDown, ChevronRight, Coins, DollarSign, Gauge, ShieldAlert } from "lucide-react";
import { budgetsApi } from "../api/budgets";
import { costsApi } from "../api/costs";
import { BudgetIncidentCard } from "../components/BudgetIncidentCard";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { EmptyState } from "../components/EmptyState";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { PRESET_KEYS, PRESET_LABELS, useDateRange } from "../hooks/useDateRange";
import { queryKeys } from "../lib/queryKeys";
import { billingTypeDisplayName, cn, formatCents, formatTokens, providerDisplayName } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const NO_COMPANY = "__none__";

function MetricTile({
  label,
  value,
  subtitle,
  icon: Icon,
}: {
  label: string;
  value: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-border">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

function tokenTotal(row: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}) {
  return row.inputTokens + row.cachedInputTokens + row.outputTokens;
}

export function AgentUsageCosts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    from,
    to,
    customReady,
  } = useDateRange();

  const companyId = selectedCompanyId ?? NO_COMPANY;

  useEffect(() => {
    setBreadcrumbs([{ label: "Agent usage" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setExpandedAgents(new Set());
  }, [companyId, from, to]);

  const { data: budgetData, isLoading: budgetLoading, error: budgetError } = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const { data: usageData, isLoading: usageLoading, error: usageError } = useQuery({
    queryKey: queryKeys.costs(companyId, from || undefined, to || undefined),
    queryFn: async () => {
      const [summary, byAgent, byAgentModel] = await Promise.all([
        costsApi.summary(companyId, from || undefined, to || undefined),
        costsApi.byAgent(companyId, from || undefined, to || undefined),
        costsApi.byAgentModel(companyId, from || undefined, to || undefined),
      ]);
      return { summary, byAgent, byAgentModel };
    },
    enabled: Boolean(selectedCompanyId) && customReady,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const invalidateBudgetViews = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.costs(selectedCompanyId, from || undefined, to || undefined) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
  };

  const policyMutation = useMutation({
    mutationFn: (input: {
      scopeType: BudgetPolicySummary["scopeType"];
      scopeId: string;
      amount: number;
      windowKind: BudgetPolicySummary["windowKind"];
    }) =>
      budgetsApi.upsertPolicy(companyId, {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        amount: input.amount,
        windowKind: input.windowKind,
      }),
    onSuccess: invalidateBudgetViews,
  });

  const incidentMutation = useMutation({
    mutationFn: (input: { incidentId: string; action: "keep_paused" | "raise_budget_and_resume"; amount?: number }) =>
      budgetsApi.resolveIncident(companyId, input.incidentId, input),
    onSuccess: invalidateBudgetViews,
  });

  const agentModelRows = useMemo(() => {
    const map = new Map<string, CostByAgentModel[]>();
    for (const row of usageData?.byAgentModel ?? []) {
      const rows = map.get(row.agentId) ?? [];
      rows.push(row);
      map.set(row.agentId, rows);
    }
    for (const [agentId, rows] of map) {
      map.set(agentId, rows.slice().sort((a, b) => b.costCents - a.costCents));
    }
    return map;
  }, [usageData?.byAgentModel]);

  const agentPolicies = useMemo(
    () => (budgetData?.policies ?? []).filter((policy) => policy.scopeType === "agent"),
    [budgetData?.policies],
  );

  const agentPoliciesByScopeId = useMemo(() => {
    const map = new Map<string, BudgetPolicySummary>();
    for (const policy of agentPolicies) map.set(policy.scopeId, policy);
    return map;
  }, [agentPolicies]);

  const activeAgentIncidents = useMemo(
    () => (budgetData?.activeIncidents ?? []).filter((incident) => incident.scopeType === "agent"),
    [budgetData?.activeIncidents],
  );

  const totals = useMemo(() => {
    const rows = usageData?.byAgent ?? [];
    return {
      spendCents: rows.reduce((sum, row) => sum + row.costCents, 0),
      tokens: rows.reduce((sum, row) => sum + tokenTotal(row), 0),
      agentCount: rows.length,
      budgetCents: agentPolicies.reduce((sum, policy) => sum + policy.amount, 0),
    };
  }, [agentPolicies, usageData?.byAgent]);

  function toggleAgent(agentId: string) {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view agent usage." />;
  }

  const showCustomPrompt = preset === "custom" && !customReady;
  const error = usageError ?? budgetError;
  const loading = (usageLoading || budgetLoading) && customReady;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Agent usage</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Per-agent inference usage, model breakdowns, and agent budget limits.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {PRESET_KEYS.map((key) => (
              <Button
                key={key}
                variant={preset === key ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setPreset(key)}
              >
                {PRESET_LABELS[key]}
              </Button>
            ))}
          </div>
        </div>

        {preset === "custom" ? (
          <div className="flex flex-wrap items-center gap-2 border border-border p-3">
            <input
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            />
          </div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-4">
          <MetricTile
            label="Agent spend"
            value={formatCents(totals.spendCents)}
            subtitle={`${formatTokens(totals.tokens)} tokens in this range`}
            icon={DollarSign}
          />
          <MetricTile
            label="Agents with usage"
            value={String(totals.agentCount)}
            subtitle="Agents with recorded cost events"
            icon={Gauge}
          />
          <MetricTile
            label="Agent budgets"
            value={totals.budgetCents > 0 ? formatCents(totals.budgetCents) : "Open"}
            subtitle={`${agentPolicies.length} configured agent limits`}
            icon={Coins}
          />
          <MetricTile
            label="Budget incidents"
            value={String(activeAgentIncidents.length)}
            subtitle={`${budgetData?.pausedAgentCount ?? 0} agents paused by budget`}
            icon={ShieldAlert}
          />
        </div>
      </div>

      {showCustomPrompt ? (
        <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
      ) : loading ? (
        <PageSkeleton variant="costs" />
      ) : error ? (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      ) : (
        <div className="space-y-4">
          {activeAgentIncidents.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {activeAgentIncidents.map((incident) => (
                <BudgetIncidentCard
                  key={incident.id}
                  incident={incident}
                  isMutating={incidentMutation.isPending}
                  onKeepPaused={() => incidentMutation.mutate({ incidentId: incident.id, action: "keep_paused" })}
                  onRaiseAndResume={(amount) =>
                    incidentMutation.mutate({
                      incidentId: incident.id,
                      action: "raise_budget_and_resume",
                      amount,
                    })}
                />
              ))}
            </div>
          ) : null}

          <Card>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base">Per-agent usage</CardTitle>
              <CardDescription>Expand an agent to see provider, model, token, and billing-type detail.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 px-5 pb-5 pt-2">
              {(usageData?.byAgent.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">No agent usage recorded for this period.</p>
              ) : (
                usageData?.byAgent.map((row) => {
                  const modelRows = agentModelRows.get(row.agentId) ?? [];
                  const policy = agentPoliciesByScopeId.get(row.agentId);
                  const isExpanded = expandedAgents.has(row.agentId);
                  const hasBreakdown = modelRows.length > 0;
                  return (
                    <div key={row.agentId} className="border border-border px-4 py-3">
                      <div
                        className={cn("flex items-start justify-between gap-3", hasBreakdown ? "cursor-pointer select-none" : "")}
                        onClick={() => hasBreakdown && toggleAgent(row.agentId)}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {hasBreakdown ? (
                            isExpanded
                              ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                              : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                          ) : (
                            <span className="h-3 w-3 shrink-0" />
                          )}
                          <Identity name={row.agentName ?? row.agentId} size="sm" />
                          {row.agentStatus === "terminated" ? <StatusBadge status="terminated" /> : null}
                        </div>
                        <div className="text-right text-sm tabular-nums">
                          <div className="font-medium">{formatCents(row.costCents)}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatTokens(tokenTotal(row))} tokens
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {policy?.amount ? `${policy.utilizationPercent}% of ${formatCents(policy.amount)}` : "No agent budget"}
                          </div>
                        </div>
                      </div>

                      {isExpanded && modelRows.length > 0 ? (
                        <div className="mt-3 space-y-2 border-l border-border pl-4">
                          {modelRows.map((modelRow) => {
                            const sharePct = row.costCents > 0 ? Math.round((modelRow.costCents / row.costCents) * 100) : 0;
                            return (
                              <div
                                key={`${modelRow.provider}:${modelRow.model}:${modelRow.billingType}`}
                                className="flex items-start justify-between gap-3 text-xs"
                              >
                                <div className="min-w-0">
                                  <div className="truncate font-medium text-foreground">
                                    {providerDisplayName(modelRow.provider)}
                                    <span className="mx-1 text-border">/</span>
                                    <span className="font-mono">{modelRow.model}</span>
                                  </div>
                                  <div className="truncate text-muted-foreground">
                                    {providerDisplayName(modelRow.biller)} · {billingTypeDisplayName(modelRow.billingType)}
                                  </div>
                                </div>
                                <div className="text-right tabular-nums">
                                  <div className="font-medium">
                                    {formatCents(modelRow.costCents)}
                                    <span className="ml-1 font-normal text-muted-foreground">({sharePct}%)</span>
                                  </div>
                                  <div className="text-muted-foreground">{formatTokens(tokenTotal(modelRow))} tokens</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base">Agent budgets</CardTitle>
              <CardDescription>Monthly hard-stop limits for individual agents.</CardDescription>
            </CardHeader>
            <CardContent className="px-5 pb-5 pt-2">
              {agentPolicies.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No agent budgets configured yet. Set a budget from an agent detail page.
                </p>
              ) : (
                <div className="grid gap-4 xl:grid-cols-2">
                  {agentPolicies.map((summary) => (
                    <BudgetPolicyCard
                      key={summary.policyId}
                      summary={summary}
                      isSaving={policyMutation.isPending}
                      onSave={(amount) =>
                        policyMutation.mutate({
                          scopeType: summary.scopeType,
                          scopeId: summary.scopeId,
                          amount,
                          windowKind: summary.windowKind,
                        })}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
