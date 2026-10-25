/** A harness command's source, as the chip beside it reads. */
export type CommandSource = { source: string; sourceInfo?: { path?: string; origin?: string } };

/**
 * 「技能」只是一个来源，不是一个身份：技能本身还分**个人**（装在 `~/.pi/agent/`）
 * 和**项目**（放在当前 checkout 里）。设置页和输入框的补全列表读同一份判断，
 * 否则同一行在两处会叫两个名字。
 */
export function skillBadge(command: CommandSource): string {
  if (command.source === "extension") return "扩展";
  if (command.source === "template") return "模板";
  if (command.source !== "skill") return command.source;
  return (command.sourceInfo?.path ?? "").includes("/.pi/agent/") ? "个人" : "项目";
}
