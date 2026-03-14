import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./app/router";
import { installGlobalErrorOverlay } from "./global-error-overlay";
import "./styles.css";

// Surface ALL uncaught errors / unhandled rejections as a visible overlay
// with full stack traces, so nothing is silently swallowed by the console.
installGlobalErrorOverlay();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
