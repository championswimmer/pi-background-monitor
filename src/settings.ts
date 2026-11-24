import { defineSettings, field } from "pi-extension-settings-tui/schema";
import {
  createSessionStorageAdapter,
  createSettingsStore,
  isPlainRecord,
  type SessionEntryLike,
  type SettingsStore,
} from "pi-extension-settings-tui/store";
import { DEFAULT_LIMITS, MAX_MONITORS, validLimits } from "./limits.ts";

export const SETTINGS_FILE = "pi-background-monitor.json";
export const SESSION_SETTINGS_ENTRY = "pi-background-monitor:settings:v1";

export const bgmonSettingsSchema = defineSettings({
  id: "pi-background-monitor",
  title: "Background Monitor Settings",
  description: `Limits shared with subagents (1–${MAX_MONITORS}); lowering never removes jobs.`,
  settingsFile: SETTINGS_FILE,
  scopes: ["global", "project", "session"],
  defaultScope: "global",
  saveMode: "session-draft",
  fields: {
    maxOpen: field.integer({
      label: "Maximum running monitors",
      description: `Default: ${DEFAULT_LIMITS.maxOpen}. Shared with subagents (1–${MAX_MONITORS}); lowering never removes jobs.`,
      default: DEFAULT_LIMITS.maxOpen,
      min: 1,
      max: MAX_MONITORS,
      step: 1,
    }),
    maxTotal: field.integer({
      label: "Maximum retained monitors",
      description: `Default: ${DEFAULT_LIMITS.maxTotal}; includes finished, cancelled and lost jobs. Shared with subagents (1–${MAX_MONITORS}); lowering never removes jobs.`,
      default: DEFAULT_LIMITS.maxTotal,
      min: 1,
      max: MAX_MONITORS,
      step: 1,
    }),
  },
});

export type BgmonSettings = typeof bgmonSettingsSchema.Type;
export type BgmonSettingsStore = SettingsStore<typeof bgmonSettingsSchema.fields>;

export function createBgmonSessionAdapter(options: {
  readonly session: string;
  readonly appendEntry: (entryType: string, data: Record<string, unknown>) => void | Promise<void>;
  readonly getEntries: () => readonly SessionEntryLike[];
}) {
  const { session } = options;
  return createSessionStorageAdapter({
    entryType: SESSION_SETTINGS_ENTRY,
    scope: "session",
    appendEntry: options.appendEntry,
    getEntries: options.getEntries,
    matchEntry: (entry) => {
      if (!isPlainRecord(entry.data) || entry.data.session !== session) {
        return false;
      }
      if (entry.data.__deleted === true) {
        return true;
      }
      return validLimits(entry.data.limits) || isPlainRecord(entry.data.overrides);
    },
    deserialize: (data) => {
      if (validLimits(data.limits)) {
        return { maxOpen: data.limits.maxOpen, maxTotal: data.limits.maxTotal };
      }
      if (isPlainRecord(data.overrides)) {
        return data.overrides;
      }
      return null;
    },
    serialize: (data) => ({ session, overrides: data }),
    deletedData: { session },
  });
}

export function createBgmonSettingsStore(options: {
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly session: string;
  readonly appendEntry: (entryType: string, data: Record<string, unknown>) => void | Promise<void>;
  readonly getEntries: () => readonly SessionEntryLike[];
}): BgmonSettingsStore {
  return createSettingsStore(bgmonSettingsSchema, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionAdapter: createBgmonSessionAdapter({
      session: options.session,
      appendEntry: options.appendEntry,
      getEntries: options.getEntries,
    }),
  });
}
