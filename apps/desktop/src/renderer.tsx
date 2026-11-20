import { createRoot } from "react-dom/client";
import { DesktopApp } from "./desktop-app.js";
import { DesktopTheme } from "./ui/theme.js";

const host = document.getElementById("app");
if (host) {
  createRoot(host).render(
    <DesktopTheme>
      <DesktopApp />
    </DesktopTheme>,
  );
}
