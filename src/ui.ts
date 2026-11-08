import { type ExtensionContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import { sanitize } from "./output.ts";

export type Limits = { maxOpen: number; maxTotal: number };
export const DEFAULT_LIMITS: Limits = { maxOpen: 8, maxTotal: 8 };
export function validLimits(value: unknown): value is Limits {
  const v = value as Limits | null;
  return !!v && [v.maxOpen, v.maxTotal].every((n) => Number.isInteger(n) && n >= 1 && n <= 8);
}
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

export async function settingsDialog(
  ctx: ExtensionContext,
  limits: Limits,
  save: (value: Limits) => void,
) {
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const values = Array.from({ length: 8 }, (_, i) => String(i + 1));
    const container = new Container();
    container.addChild({
      render: () => [
        theme.fg("accent", theme.bold("Background monitor settings")),
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
      () => done(),
    );
    container.addChild(list);
    return {
      render: (width: number) =>
        container.render(width).map((line) => truncateToWidth(line, width)),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export async function dashboard(ctx: ExtensionContext, jobs: Job[], watches: Watch[]) {
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let selected = 0;
    return {
      render(width: number) {
        const lines: string[] = [
          theme.fg("accent", theme.bold("Background monitors")),
          theme.fg(
            "muted",
            `${jobs.length} shared monitor${jobs.length === 1 ? "" : "s"} · ${watches.length} session watch${watches.length === 1 ? "" : "es"}`,
          ),
          "",
        ];
        if (!jobs.length) lines.push("No monitors yet. Start one with bgmon_start.");
        else {
          lines.push(theme.fg("muted", "  STATUS     ID                        COMMAND"));
          const capacity = Math.max(1, (tui.terminal.rows || 24) - 13);
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
        lines.push(
          "",
          theme.fg("muted", "↑/↓ select · Esc/Enter close · /bgmon settings configure limits"),
        );
        return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
      },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm"))
          done();
        else if (keys.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
        else if (keys.matches(data, "tui.select.down"))
          selected = Math.max(0, Math.min(jobs.length - 1, selected + 1));
        tui.requestRender();
      },
      invalidate() {},
    };
  });
}
