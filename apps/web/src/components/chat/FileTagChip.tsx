import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { ContextChipLabel } from "../ContextChip";
import { WorkspaceEntryIcon } from "./WorkspaceEntryIcon";

export function FileTagChipContent(props: {
  path: string;
  label: string;
  theme: "light" | "dark";
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
  /** Shown in front of the icon, such as a resolved link's mark. */
  leading?: ReactNode | undefined;
  labelClassName?: string | undefined;
}) {
  return (
    <>
      {props.leading}
      <WorkspaceEntryIcon
        path={props.path}
        environmentId={props.environmentId}
        cwd={props.cwd}
        theme={props.theme}
      />
      <ContextChipLabel className={props.labelClassName}>{props.label}</ContextChipLabel>
    </>
  );
}
