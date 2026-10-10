import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCcw, Trash2, TriangleAlert } from "lucide-react";
import type { PortForwardRule, PortForwardRuntimeStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import {
  EMPTY_RULE_FORM,
  PortForwardRuleForm,
  ruleFormToUpsert,
  type RuleFormState,
} from "@/settings/PortForwardRuleForm.js";

interface PortForwardSectionProps {
  workspacePath: string | null;
  workspaceIdentity?: string;
}

function parsePort(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
}

export function PortForwardSection({ workspacePath, workspaceIdentity }: PortForwardSectionProps) {
  const { intl } = useZCodeIntl();
  const zcodeTaskService = useZCodeTaskService(
    workspacePath ?? undefined,
    undefined,
    workspaceIdentity,
  );
  const [rules, setRules] = useState<PortForwardRule[]>([]);
  const [statuses, setStatuses] = useState<PortForwardRuntimeStatus[]>([]);
  const [form, setForm] = useState<RuleFormState>(EMPTY_RULE_FORM);
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusByRuleId = useMemo(() => {
    const map = new Map<string, PortForwardRuntimeStatus>();
    for (const status of statuses) {
      map.set(status.ruleId, status);
    }
    return map;
  }, [statuses]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [nextRules, nextStatuses] = await Promise.all([
        zcodeTaskService.listPortForwardRules(),
        zcodeTaskService.getPortForwardStatuses(),
      ]);
      setRules(nextRules);
      setStatuses(nextStatuses);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoading(false);
    }
  }, [zcodeTaskService]);

  useEffect(() => {
    void refresh();
    // 状态由 Host 端状态机维护，这里轮询保持面板新鲜；状态事件桥接留待后续统一接入。
    const timer = window.setInterval(() => {
      void zcodeTaskService
        .getPortForwardStatuses()
        .then(setStatuses)
        .catch(() => {});
    }, 3000);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh, zcodeTaskService]);

  const startEdit = (rule: PortForwardRule): void => {
    setIsEditing(true);
    setForm({
      ruleId: rule.ruleId,
      name: rule.name,
      host: rule.target.host,
      port: String(rule.target.port ?? 22),
      username: rule.target.username,
      privateKeyPath: rule.target.privateKeyPath ?? "",
      direction: rule.direction,
      localHost: rule.localHost,
      localPort: String(rule.localPort),
      remoteHost: rule.remoteHost,
      remotePort: String(rule.remotePort),
      autoStart: rule.autoStart,
      enabled: rule.enabled,
      password: "",
    });
  };

  const resetForm = (): void => {
    setIsEditing(false);
    setForm(EMPTY_RULE_FORM);
  };

  const saveForm = async (): Promise<void> => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError(intl.formatMessage({ id: "settings.portForward.error.required" }));
      return;
    }
    const ports = [form.port, form.localPort, form.remotePort].map(parsePort);
    if (ports.some((port) => port === undefined)) {
      setError(intl.formatMessage({ id: "settings.portForward.error.ports" }));
      return;
    }

    setIsSaving(true);
    try {
      await zcodeTaskService.savePortForwardRule(ruleFormToUpsert(form));
      resetForm();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSaving(false);
    }
  };

  const toggleRule = async (rule: PortForwardRule, enabled: boolean): Promise<void> => {
    try {
      await zcodeTaskService.setPortForwardRuleEnabled({
        ruleId: rule.ruleId,
        enabled,
        // 表单里刚填的密码只对当前编辑中的规则生效；其余规则按已保存配置启动。
        ...(form.password.trim() && rule.ruleId === form.ruleId
          ? { credential: { password: form.password.trim() } }
          : {}),
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const deleteRule = async (ruleId: string): Promise<void> => {
    try {
      await zcodeTaskService.deletePortForwardRule({ ruleId });
      if (form.ruleId === ruleId) {
        resetForm();
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardHeader className="border-b border-border">
          <CardAction>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isLoading}
                onClick={() => {
                  void refresh();
                }}
              >
                {isLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCcw className="size-3.5" />
                )}
                {intl.formatMessage({ id: "settings.portForward.refresh" })}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  resetForm();
                }}
              >
                <Plus className="size-3.5" />
                {intl.formatMessage({ id: "settings.portForward.new" })}
              </Button>
            </div>
          </CardAction>
          <div className="space-y-1">
            <CardTitle>{intl.formatMessage({ id: "settings.portForward.title" })}</CardTitle>
            <CardDescription>
              {intl.formatMessage({ id: "settings.portForward.description" })}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-4 py-4">
          {error ? (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertTitle>
                {intl.formatMessage({ id: "settings.portForward.error.title" })}
              </AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {rules.length === 0 && !isLoading ? (
            <div className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.portForward.empty" })}
            </div>
          ) : null}

          <div className="space-y-2">
            {rules.map((rule) => {
              const status = statusByRuleId.get(rule.ruleId);
              const state = status?.state ?? "stopped";
              return (
                <div
                  key={rule.ruleId}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-ui-base font-medium text-foreground">
                        {rule.name}
                      </span>
                      <Badge variant="outline">
                        {rule.direction === "local"
                          ? intl.formatMessage({ id: "settings.portForward.direction.local" })
                          : intl.formatMessage({ id: "settings.portForward.direction.reverse" })}
                      </Badge>
                      <Badge
                        variant={
                          state === "running"
                            ? "default"
                            : state === "error"
                              ? "destructive"
                              : "outline"
                        }
                      >
                        {intl.formatMessage({ id: `settings.portForward.state.${state}` })}
                      </Badge>
                    </div>
                    <div className="truncate text-ui-sm text-foreground-subtle">
                      {rule.direction === "local"
                        ? `${rule.localHost}:${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`
                        : `${rule.remoteHost}:${rule.remotePort} → ${rule.localHost}:${rule.localPort}`}
                      {" · "}
                      {rule.target.username}@{rule.target.host}
                      {status?.message ? ` · ${status.message}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(checked) => {
                        void toggleRule(rule, checked);
                      }}
                    />
                    <Button type="button" size="sm" variant="ghost" onClick={() => startEdit(rule)}>
                      {intl.formatMessage({ id: "settings.portForward.edit" })}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void deleteRule(rule.ruleId);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <PortForwardRuleForm
        form={form}
        isEditing={isEditing}
        isSaving={isSaving}
        onFormChange={setForm}
        onSave={() => {
          void saveForm();
        }}
        onCancel={resetForm}
      />
    </div>
  );
}
