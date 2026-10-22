import {
  listSupportedPiiEntities,
  type NormalizedRedactionConfig,
  normalizeFieldName,
  normalizeRedactionConfig,
  PRIVATE_KEY_RULE_ID,
  piiRuleId,
  type RedactionConfigIssue,
  type RedactionExceptionConfig,
  type RedactionRuleConfig,
  SENSITIVE_FIELD_RULE_ID,
} from "@buyong/redact";
import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
  EMPTY_SETTINGS_DOCUMENT,
  type SettingsDocument,
  type SettingsFileState,
  type SettingsScope,
  SWITCHABLE_RULE_IDS,
} from "../settings.js";
import { errorText, messageLines, type PanelMessage, paragraph, title } from "./common.js";
import { ListEditor } from "./list-editor.js";
import { SwitchList } from "./switch-list.js";
import { type MaskPreview, TryPanel } from "./try-panel.js";

/** One settings file the page can edit. */
export interface CustomTarget {
  readonly scope: SettingsScope;
  readonly path: string;
  readonly file: SettingsFileState;
  /** Why the file cannot be edited here; absent when it can. */
  readonly unavailableReason?: string;
}

export interface CustomPanelActions {
  /** The global target first, then the project target. */
  load(): Promise<readonly CustomTarget[]>;
  /** Write the file and apply the result to the running session; throws with a message the user can act on. */
  save(scope: SettingsScope, document: SettingsDocument): Promise<void>;
  preview(text: string): MaskPreview;
}

export interface CustomPanelOptions {
  readonly theme: Theme;
  readonly targets: readonly CustomTarget[];
  readonly actions: CustomPanelActions;
  requestRender(): void;
  onClose(): void;
}

const RULE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "token.aws-access-key": "AWS access key ids: AKIA or ASIA and 16 uppercase letters or digits.",
  "token.github": "GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, and github_pat_.",
  "token.openai": "OpenAI keys: sk- and 16 or more token characters.",
  "token.google": "Google API keys: AIza and 30 or more token characters.",
  "token.slack": "Slack tokens: xoxb-, xoxa-, xoxp-, xoxr-, and xoxs-.",
  "token.jwt": "JSON Web Tokens: three dot-separated segments starting with eyJ.",
  "token.stripe": "Stripe keys: sk_live_, sk_test_, rk_live_, and rk_test_.",
  "token.gitlab": "GitLab personal access tokens: glpat-.",
  "token.npm": "npm tokens: npm_ and 20 or more letters or digits.",
  "token.sendgrid": "SendGrid keys: SG. and two token segments.",
  "credential.authorization": "Basic and Bearer values of Authorization and Proxy-Authorization headers.",
  "credential.bearer": "Bearer values anywhere in text.",
  "credential.url-password": "The password in scheme://user:password@ URLs.",
  "credential.webhook-url": "The secret path after /hooks/ in http and https URLs.",
  [PRIVATE_KEY_RULE_ID]: "PEM private key blocks.",
  [SENSITIVE_FIELD_RULE_ID]:
    "Values of fields and assignments whose names end in token, password, secret, apikey, and similar, " +
    "plus your sensitive field names. Turning it off also stops masking .env-style assignments.",
};

const issueText = (issues: readonly RedactionConfigIssue[]) => issues.map((issue) => issue.message).join("; ");

function withConfig(document: SettingsDocument, change: Partial<NormalizedRedactionConfig>): SettingsDocument {
  return { ...document, config: { ...document.config, ...change } };
}

function fileDescription(target: CustomTarget): string {
  const state =
    target.file.state === "missing"
      ? "It does not exist yet; the first change creates it."
      : target.file.state === "invalid"
        ? `It cannot be edited here: ${target.file.problems.join("; ")}. Fix or delete the file first.`
        : "";
  return [target.path, state].filter(Boolean).join(". ");
}

/** `/redact-custom`: edit one settings file; every change is saved and applied at once. */
export class CustomPanel implements Component, Focusable {
  readonly #options: CustomPanelOptions;
  #targets: readonly CustomTarget[];
  #scope: SettingsScope = "global";
  #list: SettingsList;
  #submenu: (Component & Partial<Focusable>) | undefined;
  #message: PanelMessage | undefined;
  #isFocused = false;
  #isClosed = false;

  constructor(options: CustomPanelOptions) {
    this.#options = options;
    this.#targets = options.targets;
    this.#list = this.#buildList();
  }

  get focused(): boolean {
    return this.#isFocused;
  }

  set focused(value: boolean) {
    this.#isFocused = value;
    if (this.#submenu && "focused" in this.#submenu) this.#submenu.focused = value;
  }

  #target(): CustomTarget {
    const target = this.#targets.find((entry) => entry.scope === this.#scope) ?? this.#targets[0];
    if (!target) throw new Error("No settings file to edit.");
    return target;
  }

  /** The document being edited; `undefined` when the file cannot be edited. */
  #document(): SettingsDocument | undefined {
    const target = this.#target();
    if (target.unavailableReason) return undefined;
    if (target.file.state === "valid") return target.file.document;
    return target.file.state === "missing" ? EMPTY_SETTINGS_DOCUMENT : undefined;
  }

  #requireDocument(): SettingsDocument {
    const document = this.#document();
    if (!document) throw new Error(`${this.#target().path} cannot be edited here.`);
    return document;
  }

  async #save(change: (document: SettingsDocument) => SettingsDocument): Promise<void> {
    const scope = this.#target().scope;
    await this.#options.actions.save(scope, change(this.#requireDocument()));
    this.#targets = await this.#options.actions.load();
  }

  /** A submenu item whose component is tracked for focus, and whose closing rebuilds this list. */
  #submenuOf<T extends Component & Partial<Focusable>>(
    id: string,
    create: (close: () => void) => T,
  ): SettingItem["submenu"] {
    return (_value, done) => {
      const component = create(() => {
        this.#submenu = undefined;
        done();
        this.#rebuild(id);
      });
      if ("focused" in component) component.focused = this.#isFocused;
      this.#submenu = component;
      return component;
    };
  }

  #items(): SettingItem[] {
    const theme = this.#options.theme;
    const requestRender = () => this.#options.requestRender();
    const target = this.#target();
    const project = this.#targets.find((entry) => entry.scope === "project");
    const canSwitch = project !== undefined && project.unavailableReason === undefined;
    const items: SettingItem[] = [
      {
        id: "file",
        label: "Settings file",
        currentValue: target.scope,
        ...(canSwitch ? { values: ["global", "project"] } : {}),
        description: [fileDescription(target), canSwitch ? "" : project?.unavailableReason].filter(Boolean).join(" "),
      },
    ];
    const document = this.#document();
    const tryItem: SettingItem = {
      id: "try",
      label: "Try masking",
      currentValue: "",
      description: "Mask a line you type with the saved settings. Nothing typed here is stored or sent.",
      submenu: this.#submenuOf(
        "try",
        (close) =>
          new TryPanel({
            theme,
            preview: (text) => this.#options.actions.preview(text),
            requestRender,
            onClose: close,
          }),
      ),
    };
    if (!document) return [...items, tryItem];
    const { config } = document;

    const disabled = new Set(document.disabledRules);
    items.push(
      target.scope === "global"
        ? {
            id: "rules",
            label: "Built-in rules",
            currentValue: `${SWITCHABLE_RULE_IDS.length - disabled.size} of ${SWITCHABLE_RULE_IDS.length} on`,
            description: "Turn off a built-in rule that masks values you need to see. This weakens masking.",
            submenu: this.#submenuOf(
              "rules",
              (close) =>
                new SwitchList({
                  theme,
                  heading: "Built-in rules",
                  intro: "Only the global settings file can turn built-in rules off.",
                  items: SWITCHABLE_RULE_IDS.map((id) => ({ id, label: id, description: RULE_DESCRIPTIONS[id] })),
                  isOn: (id) => !(this.#document()?.disabledRules ?? []).includes(id),
                  setOn: (id, isOn) =>
                    this.#save((current) => {
                      const next = new Set(current.disabledRules);
                      if (isOn) next.delete(id);
                      else next.add(id);
                      return { ...current, disabledRules: SWITCHABLE_RULE_IDS.filter((ruleId) => next.has(ruleId)) };
                    }),
                  requestRender,
                  onClose: close,
                }),
            ),
          }
        : {
            id: "rules",
            label: "Built-in rules",
            currentValue: "global file only",
            description: "Only the global settings file can turn built-in rules off.",
          },
    );

    const entities = listSupportedPiiEntities();
    items.push({
      id: "pii",
      label: "Personal information",
      currentValue: config.piiEntities.length ? `${config.piiEntities.length} on` : "off",
      description:
        "Opt-in detectors such as e-mail addresses, card numbers, and national ids. " +
        "Values that only look like an identifier can be masked too.",
      submenu: this.#submenuOf(
        "pii",
        (close) =>
          new SwitchList({
            theme,
            heading: "Personal information",
            intro: `Type to search the ${entities.length} entities. Each one reports the rule id pii.<name>.`,
            items: entities.map((name) => ({ id: name, label: name, description: `Rule id ${piiRuleId(name)}` })),
            isSearchable: true,
            isOn: (name) => (this.#document()?.config.piiEntities ?? []).includes(name),
            setOn: (name, isOn) =>
              this.#save((current) => {
                const next = new Set(current.config.piiEntities);
                if (isOn) next.add(name);
                else next.delete(name);
                return withConfig(current, { piiEntities: entities.filter((entity) => next.has(entity)) });
              }),
            requestRender,
            onClose: close,
          }),
      ),
    });

    items.push({
      id: "fields",
      label: "Sensitive field names",
      currentValue: String(config.sensitiveFields.length),
      description:
        "Exact names whose values are masked, compared with letters and digits only and ignoring case " +
        "(OPENAI_KEY also matches openaiKey).",
      submenu: this.#submenuOf(
        "fields",
        (close) =>
          new ListEditor<string>({
            theme,
            heading: "Sensitive field names",
            intro: "Values of these JSON fields and key=value assignments are masked.",
            addLabel: "Add field name",
            emptyText: "No field names yet.",
            entries: () => this.#document()?.config.sensitiveFields ?? [],
            describe: (name) => ({ label: name }),
            fields: () => [{ label: "Field name", placeholder: "for example OPENAI_KEY" }],
            valuesOf: (name) => [name],
            build: ([name = ""], index) => {
              const { issues } = normalizeRedactionConfig({ sensitiveFields: [name] });
              if (issues.length) return { error: issueText(issues) };
              const key = normalizeFieldName(name);
              const fields = this.#document()?.config.sensitiveFields ?? [];
              if (fields.some((field, position) => position !== index && normalizeFieldName(field) === key))
                return { error: `${name} is already in the list.` };
              return { entry: name };
            },
            save: (sensitiveFields) => this.#save((current) => withConfig(current, { sensitiveFields })),
            requestRender,
            onClose: close,
          }),
      ),
    });

    items.push({
      id: "patterns",
      label: "Custom patterns",
      currentValue: String(config.rules.length),
      description:
        "Regular expressions for values the built-in rules miss. A pattern masks its whole match, " +
        "or only the (?<secret>…) group when it has one.",
      submenu: this.#submenuOf(
        "patterns",
        (close) =>
          new ListEditor<RedactionRuleConfig>({
            theme,
            heading: "Custom patterns",
            intro: "Patterns run on untrusted text; avoid nested repetition such as (a+)+.",
            addLabel: "Add pattern",
            emptyText: "No custom patterns yet.",
            entries: () => this.#document()?.config.rules ?? [],
            describe: (rule) => ({ label: rule.id, description: `/${rule.pattern}/${rule.flags ?? ""}` }),
            fields: () => [
              { label: "Rule id", placeholder: "for example acme-token (custom. is added)" },
              { label: "Pattern", placeholder: "JavaScript regular expression, for example ACME_[A-Z0-9]{20}" },
              { label: "Flags", placeholder: "any of i, m, s, u, or empty", isOptional: true },
            ],
            valuesOf: (rule) => [rule.id, rule.pattern, rule.flags ?? ""],
            build: ([rawId = "", pattern = "", flags = ""], index) => {
              const id = rawId.startsWith("custom.") ? rawId : `custom.${rawId}`;
              const rules = this.#document()?.config.rules ?? [];
              if (rules.some((rule, position) => position !== index && rule.id === id))
                return { error: `${id} already exists; edit it instead.` };
              const { config: checked, issues } = normalizeRedactionConfig({
                rules: [flags ? { id, pattern, flags } : { id, pattern }],
              });
              const rule = checked.rules[0];
              if (issues.length || !rule) return { error: issueText(issues) || "The pattern could not be read." };
              return { entry: rule };
            },
            save: (rules) => this.#save((current) => withConfig(current, { rules })),
            requestRender,
            onClose: close,
          }),
      ),
    });

    items.push({
      id: "exceptions",
      label: "Exceptions",
      currentValue: String(config.exceptions.length),
      description: "Exact values that stay visible for one rule, such as a documented example key.",
      submenu: this.#submenuOf(
        "exceptions",
        (close) =>
          new ListEditor<RedactionExceptionConfig>({
            theme,
            heading: "Exceptions",
            intro: "Each exception keeps one exact value visible for one rule; other rules can still mask it.",
            addLabel: "Add exception",
            emptyText: "No exceptions yet.",
            entries: () => this.#document()?.config.exceptions ?? [],
            describe: (exception) => ({ label: exception.ruleId, description: exception.value }),
            fields: () => {
              const current = this.#document()?.config;
              const choices = new Set([
                ...SWITCHABLE_RULE_IDS,
                ...(current?.rules.map((rule) => rule.id) ?? []),
                ...(current?.piiEntities.map(piiRuleId) ?? []),
                ...(current?.exceptions.map((exception) => exception.ruleId) ?? []),
              ]);
              return [
                { label: "Rule", choices: [...choices] },
                { label: "Visible value", placeholder: "the exact value to keep visible" },
              ];
            },
            valuesOf: (exception) => [exception.ruleId, exception.value],
            build: ([ruleId = "", value = ""], index) => {
              const exceptions = this.#document()?.config.exceptions ?? [];
              if (
                exceptions.some(
                  (entry, position) => position !== index && entry.ruleId === ruleId && entry.value === value,
                )
              )
                return { error: "This exception is already in the list." };
              const { config: checked, issues } = normalizeRedactionConfig({ exceptions: [{ ruleId, value }] });
              const exception = checked.exceptions[0];
              if (issues.length || !exception)
                return { error: issueText(issues) || "The exception could not be read." };
              return { entry: exception };
            },
            save: (exceptions) => this.#save((current) => withConfig(current, { exceptions })),
            requestRender,
            onClose: close,
          }),
      ),
    });

    items.push(tryItem);
    return items;
  }

  #buildList(selectedId?: string): SettingsList {
    const items = this.#items();
    const list = new SettingsList(
      items,
      items.length,
      getSettingsListTheme(),
      (id, value) => {
        if (id !== "file" || (value !== "global" && value !== "project")) return;
        this.#scope = value;
        this.#message = undefined;
        this.#rebuild("file");
      },
      () => this.#close(),
    );
    if (selectedId) list.selectItem(selectedId);
    return list;
  }

  #rebuild(selectedId?: string): void {
    if (this.#isClosed) return;
    try {
      this.#list = this.#buildList(selectedId);
    } catch (error) {
      this.#message = { text: errorText(error), isError: true };
    }
    this.#options.requestRender();
  }

  #close(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#options.onClose();
  }

  handleInput(data: string): void {
    if (this.#isClosed) return;
    // The list closes on its cancel key and forwards input to an open submenu.
    this.#list.handleInput(data);
    this.#options.requestRender();
  }

  render(width: number): string[] {
    const { theme } = this.#options;
    const intro = this.#submenu
      ? []
      : [
          ...paragraph(
            theme.fg(
              "muted",
              "Changes are saved as you make them and apply to this session at once. " +
                "Project settings add to the global settings.",
            ),
            width,
          ),
          "",
        ];
    return [
      title(theme, "Redact · Custom rules", width),
      ...intro,
      ...this.#list.render(width),
      ...(this.#message ? ["", ...messageLines(theme, this.#message, width)] : []),
    ];
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  dispose(): void {
    this.#isClosed = true;
  }
}
