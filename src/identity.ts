export type SessionIdentity = {
  group: string;
  origin: string;
  role: "root" | "subagent";
};

// The subagent manager writes this entry into the child session before loading extensions.
export function readSubagentIdentity(entries: readonly unknown[]): SessionIdentity | undefined {
  const matches = entries.filter(
    (entry): entry is { type: string; customType: string; data: unknown } =>
      !!entry &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "custom" &&
      (entry as { customType?: unknown }).customType === "pi-subagent:thread:v1",
  );
  if (matches.length !== 1) return undefined;
  const data = matches[0].data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const { rootId, threadPath, inheritedCount } = data as Record<string, unknown>;
  if (
    typeof rootId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rootId) ||
    typeof threadPath !== "string" ||
    !/^\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})*$/.test(
      threadPath,
    ) ||
    threadPath.split("/").length > 33 ||
    threadPath === "/root" ||
    !Number.isSafeInteger(inheritedCount) ||
    (inheritedCount as number) < 0
  )
    return undefined;
  return { group: rootId, origin: threadPath, role: "subagent" };
}
