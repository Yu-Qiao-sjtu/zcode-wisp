import { Loader2 } from "lucide-react";
import type { PortForwardDirection, PortForwardRuleUpsert } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface RuleFormState {
  ruleId?: string;
  name: string;
  host: string;
  port: string;
  username: string;
  privateKeyPath: string;
  direction: PortForwardDirection;
  localHost: string;
  localPort: string;
  remoteHost: string;
  remotePort: string;
  autoStart: boolean;
  enabled: boolean;
  /** 只在本次启动转发时使用，不持久化。 */
  password: string;
}

export const EMPTY_RULE_FORM: RuleFormState = {
  name: "",
  host: "",
  port: "22",
  username: "root",
  privateKeyPath: "",
  direction: "local",
  localHost: "127.0.0.1",
  localPort: "",
  remoteHost: "127.0.0.1",
  remotePort: "",
  autoStart: false,
  enabled: false,
  password: "",
};

export function ruleFormToUpsert(form: RuleFormState): PortForwardRuleUpsert {
  return {
    ...(form.ruleId ? { ruleId: form.ruleId } : {}),
    name: form.name.trim(),
    target: {
      host: form.host.trim(),
      port: Number.parseInt(form.port.trim(), 10),
      username: form.username.trim(),
      ...(form.privateKeyPath.trim() ? { privateKeyPath: form.privateKeyPath.trim() } : {}),
    },
    direction: form.direction,
    localHost: form.localHost.trim() || "127.0.0.1",
    localPort: Number.parseInt(form.localPort.trim(), 10),
    remoteHost: form.remoteHost.trim() || "127.0.0.1",
    remotePort: Number.parseInt(form.remotePort.trim(), 10),
    enabled: form.enabled,
    autoStart: form.autoStart,
  };
}

interface PortForwardRuleFormProps {
  form: RuleFormState;
  isEditing: boolean;
  isSaving: boolean;
  onFormChange: (form: RuleFormState) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function PortForwardRuleForm({
  form,
  isEditing,
  isSaving,
  onFormChange,
  onSave,
  onCancel,
}: PortForwardRuleFormProps) {
  const { intl } = useZCodeIntl();
  const update = (patch: Partial<RuleFormState>): void => {
    onFormChange({ ...form, ...patch });
  };

  return (
    <Card className="border border-border bg-card py-0 shadow-none">
      <CardHeader className="border-b border-border">
        <div className="space-y-1">
          <CardTitle>
            {intl.formatMessage({
              id: isEditing ? "settings.portForward.form.editTitle" : "settings.portForward.form.newTitle",
            })}
          </CardTitle>
          <CardDescription>
            {intl.formatMessage({ id: "settings.portForward.form.description" })}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 py-4">
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="portForward-name">
              {intl.formatMessage({ id: "settings.portForward.field.name" })}
            </Label>
            <Input
              id="portForward-name"
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="portForward-direction">
              {intl.formatMessage({ id: "settings.portForward.field.direction" })}
            </Label>
            <Select
              value={form.direction}
              onValueChange={(value) => update({ direction: value as PortForwardDirection })}
            >
              <SelectTrigger size="lg" className="w-full justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">
                  {intl.formatMessage({ id: "settings.portForward.direction.local" })}
                </SelectItem>
                <SelectItem value="reverse">
                  {intl.formatMessage({ id: "settings.portForward.direction.reverse" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="portForward-host">
              {intl.formatMessage({ id: "settings.portForward.field.host" })}
            </Label>
            <Input
              id="portForward-host"
              value={form.host}
              onChange={(event) => update({ host: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="portForward-port">
              {intl.formatMessage({ id: "settings.portForward.field.port" })}
            </Label>
            <Input
              id="portForward-port"
              type="number"
              value={form.port}
              onChange={(event) => update({ port: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="portForward-username">
              {intl.formatMessage({ id: "settings.portForward.field.username" })}
            </Label>
            <Input
              id="portForward-username"
              value={form.username}
              onChange={(event) => update({ username: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="portForward-key">
              {intl.formatMessage({ id: "settings.portForward.field.keyPath" })}
            </Label>
            <Input
              id="portForward-key"
              value={form.privateKeyPath}
              onChange={(event) => update({ privateKeyPath: event.target.value })}
            />
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="portForward-localHost">
              {intl.formatMessage({ id: "settings.portForward.field.localHost" })}
            </Label>
            <Input
              id="portForward-localHost"
              value={form.localHost}
              onChange={(event) => update({ localHost: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="portForward-localPort">
              {intl.formatMessage({ id: "settings.portForward.field.localPort" })}
            </Label>
            <Input
              id="portForward-localPort"
              type="number"
              value={form.localPort}
              onChange={(event) => update({ localPort: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="portForward-remoteHost">
              {intl.formatMessage({ id: "settings.portForward.field.remoteHost" })}
            </Label>
            <Input
              id="portForward-remoteHost"
              value={form.remoteHost}
              onChange={(event) => update({ remoteHost: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="portForward-remotePort">
              {intl.formatMessage({ id: "settings.portForward.field.remotePort" })}
            </Label>
            <Input
              id="portForward-remotePort"
              type="number"
              value={form.remotePort}
              onChange={(event) => update({ remotePort: event.target.value })}
            />
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="portForward-password">
              {intl.formatMessage({ id: "settings.portForward.field.password" })}
            </Label>
            <Input
              id="portForward-password"
              type="password"
              value={form.password}
              placeholder={intl.formatMessage({ id: "settings.portForward.field.passwordHint" })}
              onChange={(event) => update({ password: event.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-ui-base text-foreground">
            <Switch
              checked={form.autoStart}
              onCheckedChange={(checked) => update({ autoStart: checked })}
            />
            {intl.formatMessage({ id: "settings.portForward.field.autoStart" })}
          </label>
          <label className="flex items-center gap-2 text-ui-base text-foreground">
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
            {intl.formatMessage({ id: "settings.portForward.field.enabled" })}
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={isSaving} onClick={onSave}>
            {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {intl.formatMessage({ id: "settings.portForward.form.save" })}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            {intl.formatMessage({ id: "settings.portForward.form.cancel" })}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
