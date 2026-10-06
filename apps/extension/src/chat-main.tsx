// The chat as a full page in its own tab, like Claude and ChatGPT ("Open as
// a full page" in the side panel). Same chats and Spaces as the side panel.
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./ui/App";
import { ThemedRoot } from "./ui/ThemedRoot";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemedRoot>
      <App fullPage />
    </ThemedRoot>
  </React.StrictMode>
);
