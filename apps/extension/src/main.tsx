import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./ui/App";
import { ThemedRoot } from "./ui/ThemedRoot";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemedRoot>
      <App />
    </ThemedRoot>
  </React.StrictMode>
);
