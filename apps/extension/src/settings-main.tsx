// The big Settings tab (chrome://extensions → Details → Extension options, or
// "Bigger" in the side panel). "#ai", "#phone" and so on open one page.
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ThemedRoot } from "./ui/ThemedRoot";
import { PAGE_ACTIONS, SettingsShell, isSectionId, type SectionId } from "./ui/settings/SettingsShell";

function fromHash(): SectionId | undefined {
  const id = location.hash.replace(/^#/, "");
  return isSectionId(id) ? id : undefined;
}

function SettingsPage() {
  const [section, setSection] = useState(fromHash);
  useEffect(() => {
    const onHash = () => setSection(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return (
    <SettingsShell
      mode="page"
      initialSection={section}
      actions={PAGE_ACTIONS}
      onSectionChange={(next) => history.replaceState(null, "", `#${next}`)}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemedRoot>
      <SettingsPage />
    </ThemedRoot>
  </React.StrictMode>
);
