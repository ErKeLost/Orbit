import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "../../lib/store";
import { listProjectFiles, request } from "../../lib/rpc";
import { buildMentionIndex, projectMentionFiles, type MentionIndex, type MentionFile } from "./fileMentions";

export type ComposerCommand = {
  name: string;
  description?: string;
  source: string;
  sourceInfo?: { path?: string; origin?: string };
};

export type ComposerTokens = {
  /** Every project file, ready to be highlighted, ranked, or labelled. */
  files: MentionFile[];
  /** `@label` ⇄ file, so a picked mention resolves back to a path on send. */
  index: MentionIndex;
  /** Skill commands by name: only these get the `/` skill colour. */
  skills: ReadonlySet<string>;
  commands: ComposerCommand[];
  commandsLoading: boolean;
  filesLoading: boolean;
};

const NO_FILES: string[] = [];
const NO_COMMANDS: ComposerCommand[] = [];

/**
 * The file and command catalogs both the `@`/`/` palettes and the composer
 * highlight layer read. One query key per catalog, so opening the palette and
 * typing a mention share a single fetch.
 */
export function useComposerTokens(cwd: string, options: { commands?: boolean } = {}): ComposerTokens {
  const online = useWorkspace((state) => state.connection === "online");
  const homeDir = useWorkspace((state) => state.homeDir);
  const wantCommands = options.commands ?? true;
  // Mentions are project-relative; the home directory is not a project.
  const inProject = Boolean(cwd) && cwd !== homeDir;

  const files = useQuery({
    queryKey: ["pi", "files", cwd],
    queryFn: () => listProjectFiles(cwd),
    enabled: inProject,
    staleTime: 60_000,
  });
  const commands = useQuery({
    queryKey: ["pi", "commands", cwd],
    queryFn: () => request<{ commands: ComposerCommand[] }>({ type: "get_commands" }, 30000),
    enabled: online && wantCommands,
    staleTime: 60_000,
  });

  const fileList = files.data ?? NO_FILES;
  const mentionFiles = useMemo(() => projectMentionFiles(fileList, cwd), [fileList, cwd]);
  const index = useMemo(() => buildMentionIndex(mentionFiles), [mentionFiles]);
  const skills = useMemo(() => {
    const list = (commands.data?.commands ?? NO_COMMANDS).filter((command) => command.source === "skill");
    return new Set(list.map((command) => command.name));
  }, [commands.data]);

  return {
    files: mentionFiles,
    index,
    skills,
    commands: commands.data?.commands ?? NO_COMMANDS,
    commandsLoading: commands.isLoading,
    filesLoading: files.isLoading,
  };
}
