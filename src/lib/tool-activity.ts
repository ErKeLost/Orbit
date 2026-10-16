export type ToolKind = "read" | "search" | "command" | "edit" | "computer" | "other";

const summaryLabels: Record<ToolKind, string> = {
  read: "读取",
  search: "搜索",
  command: "运行",
  edit: "编辑",
  computer: "操作",
  other: "调用",
};

export function toolKind(toolName: string): ToolKind {
  const normalized = toolName.toLowerCase();
  if (/^(gui_task|browser_task|find_roots|observe_ui|search_ui|expand_ui|inspect_ui|act_ui|wait_for)$/.test(normalized)) return "computer";
  if (/(^|[_-])(read|view|open|cat|fetch)([_-]|$)|^read/.test(normalized)) return "read";
  if (/(^|[_-])(search|grep|rg|find|glob|list)([_-]|$)|^(search|grep|rg|find|glob)/.test(normalized)) return "search";
  if (/(^|[_-])(bash|shell|terminal|command|exec|run)([_-]|$)|^(bash|shell|terminal|command|exec|run)/.test(normalized)) return "command";
  if (/(^|[_-])(edit|write|patch|apply|create|delete|rename)([_-]|$)|^(edit|write|patch|apply|create|delete|rename)/.test(normalized)) return "edit";
  return "other";
}

export function summarizeToolCalls(toolNames: string[]) {
  const counts = toolNames.reduce<Record<ToolKind, number>>((summary, name) => {
    const kind = toolKind(name);
    summary[kind] += 1;
    return summary;
  }, { read: 0, search: 0, command: 0, edit: 0, computer: 0, other: 0 });
  return (Object.keys(summaryLabels) as ToolKind[]).flatMap(kind =>
    counts[kind] ? [`${summaryLabels[kind]} ${counts[kind]} 次`] : [],
  ).join(" · ");
}
