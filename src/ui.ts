import { type ExtensionContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  SettingsList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitize } from "./output.ts";

export type Limits = { maxOpen: number; maxTotal: number };
export const DEFAULT_LIMITS: Limits = { maxOpen: 8, maxTotal: 8 };
export function validLimits(value: unknown): value is Limits {
  const v = value as Limits | null;
  return !!v && [v.maxOpen, v.maxTotal].every((n) => Number.isInteger(n) && n >= 1 && n <= 8);
}
type Snapshot = {
  id: string;
  state: string;
  timestamp?: string;
  untrustedOutput?: { text: string; truncated: boolean };
  clientTruncated?: boolean;
};
type Viewer = { inspect: (id: string) => Promise<unknown>; signal: AbortSignal };
type Job = { id: string; state: string; command?: string };
type Watch = {
  job: string;
  kind: string;
  intervalSeconds: number;
  expires: string;
  delivery: string;
  id: string;
};
const safe = (s: string) => sanitize(s).replace(/\s+/g, " ");

// Leave one terminal row around the overlay, matching its configured margin.
const overlay = { overlay: true, overlayOptions: { width: 100, margin: 1 } };

function frame(
  lines: string[],
  width: number,
  rows: number,
  color: (text: string) => string,
): string[] {
  if (width < 2)
    return lines.slice(0, Math.max(1, rows - 2)).map((line) => truncateToWidth(line, width));
  const inner = width - 2;
  const body = lines.slice(0, Math.max(0, rows - 4));
  const border = (left: string, right: string) => color(left + "─".repeat(inner) + right);
  return [
    border("╭", "╮"),
    ...body.map((line) => {
      const content = truncateToWidth(line, inner);
      return (
        color("│") + content + " ".repeat(Math.max(0, inner - visibleWidth(content))) + color("│")
      );
    }),
    border("╰", "╯"),
  ];
}

export async function dashboard(
  ctx: ExtensionContext,
  jobs: Job[],
  watches: Watch[],
  limits: Limits,
  save: (value: Limits) => void,
  initialTab: "list" | "settings" = "list",
  listError?: string,
  viewer?: Viewer,
) {
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let tab: "list" | "settings" | "output" = initialTab;
    let selected = 0;
    let snapshot: Snapshot | undefined;
    let error: string | undefined;
    let lastUpdate: string | undefined;
    // Undefined follows the newest output; otherwise keep a stable top row while polling.
    let scrollTop: number | undefined;
    let displayedTop = 0;
    let maxTop = 0;
    let generation = 0;
    let disposed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      generation++;
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      stop();
      viewer?.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      dispose();
      done();
    };
    viewer?.signal.addEventListener("abort", abort, { once: true });
    const poll = async () => {
      if (disposed || viewer?.signal.aborted || tab !== "output" || running || !viewer) return;
      running = true;
      const version = generation;
      const id = jobs[selected].id;
      try {
        const result = await viewer.inspect(id);
        if (!result || typeof result !== "object" || !("id" in result) || !("state" in result))
          throw new Error("Invalid monitor snapshot");
        const value = result as Snapshot;
        if (!disposed && !viewer.signal.aborted && tab === "output" && generation === version) {
          snapshot = value;
          error = undefined;
          lastUpdate = new Date().toISOString();
          tui.requestRender();
        }
      } catch (e) {
        if (!disposed && !viewer.signal.aborted && tab === "output" && generation === version) {
          error = e instanceof Error ? e.message : String(e);
          tui.requestRender();
        }
      } finally {
        running = false;
        if (!disposed && !viewer.signal.aborted && tab === "output") {
          if (generation !== version) void poll();
          else {
            timer = setTimeout(() => {
              timer = undefined;
              void poll();
            }, 2000);
            timer.unref();
          }
        }
      }
    };
    const open = () => {
      if (!jobs.length || listError || !viewer) return;
      stop();
      tab = "output";
      snapshot = undefined;
      error = undefined;
      lastUpdate = undefined;
      scrollTop = undefined;
      void poll();
    };
    const back = () => {
      stop();
      tab = "list";
    };
    if (viewer?.signal.aborted) queueMicrotask(abort);
    const values = Array.from({ length: 8 }, (_, i) => String(i + 1));
    const container = new Container();
    container.addChild({
      render: () =>
        (tui.terminal.rows || 24) < 15
          ? [theme.fg("accent", theme.bold("Settings"))]
          : [
              theme.fg("accent", theme.bold("Settings")),
              "",
              "Limits apply to jobs owned by this session (hard maximum: 8).",
              "Lowering a limit never stops or removes existing jobs.",
              "",
            ],
      invalidate() {},
    });
    const list = new SettingsList(
      [
        {
          id: "maxOpen",
          label: "Maximum running monitors",
          description: "New jobs are blocked when this many jobs are running. Default: 8.",
          currentValue: String(limits.maxOpen),
          values,
        },
        {
          id: "maxTotal",
          label: "Maximum retained monitors",
          description:
            "Includes finished, cancelled and lost jobs. Forget a job to free space. Default: 8.",
          currentValue: String(limits.maxTotal),
          values,
        },
      ],
      5,
      getSettingsListTheme(),
      (id, value) => {
        limits = { ...limits, [id]: Number(value) };
        save(limits);
      },
      () => {
        dispose();
        done();
      },
    );
    container.addChild(list);
    return {
      render(width: number) {
        const tabLabel = (label: string, active: boolean) =>
          active
            ? theme.bg("selectedBg", theme.fg("text", theme.bold(` ● ${label} `)))
            : theme.fg("muted", `   ${label} `);
        const tabs = [
          theme.fg("accent", theme.bold("Background monitors")),
          `${tabLabel("Settings", tab === "settings")}  ${tabLabel("Monitors", tab === "list")}${tab === "output" ? `  ${tabLabel("Output", true)}` : `  ${theme.fg("dim", "Tab switch")}`}`,
          "",
        ];
        if (tab === "output") {
          const rows = tui.terminal.rows || 24;
          const text = snapshot?.untrustedOutput?.text;
          // Replace tabs before wrapping so they cannot move the terminal cursor outside the frame.
          const output =
            text === undefined
              ? []
              : sanitize(text)
                  .replace(/\t/g, "    ")
                  .split("\n")
                  .flatMap((line) =>
                    line ? wrapTextWithAnsi(line, Math.max(1, width - 2)) : [""],
                  );
          // capture-pane includes unused screen rows; trailing blanks would hide short output.
          while (output.length && !output[output.length - 1].trim()) output.pop();
          const capacity = Math.max(1, rows - 12);
          maxTop = Math.max(0, output.length - capacity);
          displayedTop = Math.min(scrollTop ?? maxTop, maxTop);
          const body = output.slice(displayedTop, displayedTop + capacity);
          const flags =
            snapshot?.untrustedOutput?.truncated || snapshot?.clientTruncated ? " · truncated" : "";
          const lines = [
            ...tabs,
            theme.fg(
              "accent",
              `Monitor ${safe(jobs[selected].id)} · ${safe(snapshot?.state ?? "loading")}${flags}`,
            ),
            theme.fg(
              "muted",
              `Read-only snapshot · updated ${safe(snapshot?.timestamp ?? lastUpdate ?? "never")}`,
            ),
            error ? theme.fg("error", `Refresh failed: ${safe(error)}`) : "",
            ...(body.length
              ? body
              : [
                  text === undefined
                    ? error || snapshot
                      ? "Output unavailable"
                      : "Loading output…"
                    : "(No output)",
                ]),
            "",
            theme.fg(
              "muted",
              `↑/↓ scroll · End follow${scrollTop !== undefined ? " (paused)" : ""} · Esc back`,
            ),
          ];
          return frame(lines, width, rows, (s) => theme.fg("border", s));
        }
        if (tab === "settings") {
          const lines = [
            ...tabs,
            ...container.render(Math.max(8, width - 2)),
            "",
            theme.fg("muted", "Tab switch · Esc close"),
          ];
          return frame(lines, width, tui.terminal.rows || 24, (s) => theme.fg("border", s));
        }
        const lines: string[] = [
          ...tabs,
          theme.fg(
            "muted",
            `${jobs.length} shared monitor${jobs.length === 1 ? "" : "s"} · ${watches.length} session watch${watches.length === 1 ? "" : "es"}`,
          ),
          "",
        ];
        if (listError) lines.push(theme.fg("error", safe(listError)));
        else if (!jobs.length) lines.push("No monitors yet. Start one with bgmon_start.");
        else {
          lines.push(theme.fg("muted", "  STATUS     ID                        COMMAND"));
          const capacity = Math.max(1, (tui.terminal.rows || 24) - 17);
          const start = Math.max(0, Math.min(selected - capacity + 1, jobs.length - capacity));
          for (let i = start; i < Math.min(jobs.length, start + capacity); i++) {
            const job = jobs[i];
            const row = `${i === selected ? "›" : " "} ${safe(job.state).padEnd(10)} ${safe(job.id).padEnd(25)} ${safe(job.command || "(command unavailable)")}`;
            lines.push(i === selected ? theme.fg("accent", row) : row);
          }
          const job = jobs[selected];
          const own = watches.filter((watch) => watch.job === job.id);
          lines.push(
            "",
            theme.fg("accent", "Selected monitor"),
            `Command: ${safe(job.command || "(unavailable for older monitors)")}`,
          );
          if (!own.length) lines.push("Watches: none for this session");
          else {
            lines.push(`Watches: ${own.length} in this session`);
            for (const w of own.slice(0, 3))
              lines.push(
                `  ${safe(w.kind)} · every ${w.intervalSeconds}s · expires ${safe(w.expires)} · ${safe(w.delivery)}`,
              );
            if (own.length > 3) lines.push(`  +${own.length - 3} more watches`);
          }
        }
        lines.push("", theme.fg("muted", "↑/↓ select · Enter output · Esc close · Tab switch"));
        return frame(lines, width, tui.terminal.rows || 24, (s) => theme.fg("border", s));
      },
      handleInput(data: string) {
        if (tab === "output") {
          if (keys.matches(data, "tui.select.cancel")) back();
          else if (keys.matches(data, "tui.select.up")) scrollTop = Math.max(0, displayedTop - 1);
          else if (keys.matches(data, "tui.select.down")) {
            const next = displayedTop + 1;
            scrollTop = next >= maxTop ? undefined : next;
          } else if (matchesKey(data, Key.end)) scrollTop = undefined;
        } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
          tab = tab === "list" ? "settings" : "list";
        } else if (tab === "settings") {
          list.handleInput(data);
        } else if (keys.matches(data, "tui.select.cancel")) {
          dispose();
          done();
        } else if (keys.matches(data, "tui.select.confirm")) open();
        else if (keys.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
        else if (keys.matches(data, "tui.select.down"))
          selected = Math.max(0, Math.min(jobs.length - 1, selected + 1));
        tui.requestRender();
      },
      dispose,
      invalidate() {
        container.invalidate();
      },
    };
  }, overlay);
}
