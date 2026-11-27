import { ENVIRONMENT_MACHINE_KINDS } from "@t3tools/contracts";
import { BriefcaseIcon, Gamepad2Icon, HouseIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import { m } from "../i18n/messages";
import { ENVIRONMENT_MACHINE_KIND_LABELS, environmentMachineIcon } from "./EnvironmentMachineIcon";

describe("EnvironmentMachineIcon", () => {
  it("gives every machine kind a label and an icon", () => {
    for (const kind of ENVIRONMENT_MACHINE_KINDS) {
      expect(m(ENVIRONMENT_MACHINE_KIND_LABELS[kind]), kind).toMatch(/\S/);
      expect(environmentMachineIcon(kind), kind).toBeDefined();
    }
  });

  it("draws the gaming and work machines with their own icons", () => {
    expect(environmentMachineIcon("gamepad")).toBe(Gamepad2Icon);
    expect(environmentMachineIcon("briefcase")).toBe(BriefcaseIcon);
    expect(m(ENVIRONMENT_MACHINE_KIND_LABELS.gamepad)).toBe("Gaming PC");
    expect(m(ENVIRONMENT_MACHINE_KIND_LABELS.briefcase)).toBe("Work PC");
    expect(environmentMachineIcon("home")).toBe(HouseIcon);
    expect(m(ENVIRONMENT_MACHINE_KIND_LABELS.home)).toBe("Home server");
  });
});
