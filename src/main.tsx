import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

console.log("=== MAIN.TSX: Starting app initialization ===");

const rootElement = document.getElementById("root");
console.log("=== MAIN.TSX: Root element:", rootElement);

if (!rootElement) {
  console.error("=== MAIN.TSX: Root element not found! ===");
  document.body.innerHTML = '<div style="padding:20px;color:red;font-family:monospace;">ERROR: Root element not found</div>';
} else {
  console.log("=== MAIN.TSX: Creating React root ===");
  const root = createRoot(rootElement);
  console.log("=== MAIN.TSX: Rendering App component ===");
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
  console.log("=== MAIN.TSX: Render call completed ===");
}
