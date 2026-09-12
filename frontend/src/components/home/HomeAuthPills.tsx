import { useCurrentUser } from "../../contexts/CurrentUserContext";
import type { HumanInvolvementPresetName, LoginProvider } from "../../types/shared.js";
import { HomeAdminBadge } from "./HomeAdminBadge";
import { HomeAuthModeBadge } from "./HomeAuthModeBadge";
import { HomeInvolvementBadge } from "./HomeInvolvementBadge";

interface HomeAuthPillsProps {
  mode: LoginProvider | null;
  involvementPreset?: HumanInvolvementPresetName | null;
}

export function HomeAuthPills({ mode, involvementPreset }: HomeAuthPillsProps) {
  const currentUser = useCurrentUser();
  const showAdmin = currentUser?.is_admin === true;
  if (!mode && !showAdmin && !involvementPreset) return null;
  return (
    <div className="home-auth-pills">
      <HomeAuthModeBadge mode={mode} />
      {showAdmin ? <HomeAdminBadge displayName={currentUser.displayName} /> : null}
      {involvementPreset ? <HomeInvolvementBadge preset={involvementPreset} /> : null}
    </div>
  );
}
