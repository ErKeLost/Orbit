import type { ReactNode } from "react";
import { FileTypeIcon } from "../shell/FileTypeIcon";
import { fileMentionParts, type MentionFile } from "./fileMentions";
import { skillTextParts } from "./skillTokens";

/**
 * MonoCode `ComposerHighlight`: the coloured copy of the draft that sits behind
 * the transparent `.composer-field` textarea. Tokens the user picked from the
 * `/` and `@` palettes keep their styling once they land in the text.
 */
export function ComposerHighlight({
  text,
  names,
  mentions,
}: {
  text: string;
  names: ReadonlySet<string>;
  mentions: ReadonlyMap<string, MentionFile>;
}): ReactNode {
  return (
    <>
      {skillTextParts(text, names).map((part, index) =>
        part.skill ? (
          <span key={index} className="text-skill">
            {part.text}
          </span>
        ) : (
          // Skill tokens always end on whitespace, so each remaining run still
          // starts on a boundary `@mention` matching can rely on.
          <FileMentionRuns key={index} text={part.text} mentions={mentions} />
        ),
      )}
      {/* A trailing newline needs an extra row, or the mirror is a line short. */}
      {text.endsWith("\n") ? "\n" : null}
    </>
  );
}

function FileMentionRuns({ text, mentions }: { text: string; mentions: ReadonlyMap<string, MentionFile> }): ReactNode {
  return (
    <>
      {fileMentionParts(text, mentions).map((part, index) =>
        part.file ? (
          <span key={index} className="text-mention">
            {/* The `@` keeps its width so the textarea underneath stays in
                lockstep; the file icon sits on top of it. */}
            <span className="relative text-transparent">
              {"@"}
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                <FileTypeIcon name={part.file.name} isDir={part.file.isDir} size={13} />
              </span>
            </span>
            {part.text.slice(1)}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
