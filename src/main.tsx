import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { initializePlatform } from "./lib/platform";

initializePlatform().then(() => ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)).catch((error) => {
  document.getElementById("root")!.textContent = `Ereader 启动失败：${String(error)}`;
});
