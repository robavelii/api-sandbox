"use client";
import { useEffect, useState } from "react";

type Mode = "system" | "light" | "dark";
const key = "spectwin-mode";

// The stored choice is applied before first paint by the script in layout.tsx.
export default function ThemeSelect() {
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    const current = document.documentElement.dataset.mode;
    if (current === "light" || current === "dark") setMode(current);
  }, []);
  return (
    <div className="field theme-select">
      <label htmlFor="theme-mode">Theme</label>
      <select
        id="theme-mode"
        value={mode}
        onChange={(event) => {
          const next = event.target.value as Mode;
          setMode(next);
          const root = document.documentElement;
          if (next === "system") delete root.dataset.mode;
          else root.dataset.mode = next;
          try {
            if (next === "system") localStorage.removeItem(key);
            else localStorage.setItem(key, next);
          } catch {}
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  );
}
